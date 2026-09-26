package com.velogrip.rfid.protocol;

import com.velogrip.rfid.TagRead;

import java.io.ByteArrayOutputStream;
import java.util.ArrayList;
import java.util.List;

/**
 * Minimal LLRP (Low Level Reader Protocol, EPCglobal 1.0.1) client engine for
 * Impinj/Zebra-class readers — the "RFID-LLRP" option in commercial timing
 * software. Default TCP port 5084.
 *
 * On connect the engine queues a handshake that puts the reader into
 * continuous inventory:
 *   SET_READER_CONFIG — ask for periodic KEEPALIVEs, so silence means trouble
 *   DELETE_ROSPEC(0)  — clear anything a previous session left behind
 *   ADD_ROSPEC        — null start/stop triggers, all antennas, report per tag
 *   ENABLE_ROSPEC
 *   START_ROSPEC
 *   ENABLE_EVENTS_AND_REPORTS
 *
 * Incoming RO_ACCESS_REPORT messages are decoded into TagReads (EPC-96 or
 * EPCData, PeakRSSI when present). Each read is stamped with the time the
 * READER saw the tag, not the time this app got round to parsing it — see
 * {@link ReaderClock}. KEEPALIVEs are acknowledged so the reader
 * does not drop the connection, and {@link #keepaliveSeen()} reports whether
 * any has arrived — a caller can only treat silence as a dead link once the
 * reader has proved it does send them. All other messages (responses, reader event
 * notifications) are skipped by length.
 *
 * Wire formats:
 *   message header:  u16 (rsvd:3 ver:3 type:10) | u32 total length | u32 id
 *   TLV parameter:   u16 (rsvd:6 type:10) | u16 length | value
 *   TV parameter:    u8  (1:1 type:7) | fixed-size value
 */
public final class LlrpEngine implements TagParser {

    // message types
    private static final int MSG_SET_READER_CONFIG = 3;
    private static final int MSG_GET_REPORT = 60;
    private static final int MSG_ADD_ROSPEC = 20;
    private static final int MSG_DELETE_ROSPEC = 21;
    private static final int MSG_START_ROSPEC = 22;
    private static final int MSG_ENABLE_ROSPEC = 24;
    private static final int MSG_RO_ACCESS_REPORT = 61;
    private static final int MSG_KEEPALIVE = 62;
    private static final int MSG_ENABLE_EVENTS_AND_REPORTS = 64;
    private static final int MSG_KEEPALIVE_ACK = 72;

    // parameter types
    private static final int P_ROSPEC = 177;
    private static final int P_RO_BOUNDARY_SPEC = 178;
    private static final int P_ROSPEC_START_TRIGGER = 179;
    private static final int P_ROSPEC_STOP_TRIGGER = 182;
    private static final int P_AISPEC = 183;
    private static final int P_AISPEC_STOP_TRIGGER = 184;
    private static final int P_INVENTORY_PARAMETER_SPEC = 186;
    private static final int P_KEEPALIVE_SPEC = 220;
    private static final int P_EVENTS_AND_REPORTS = 1023;
    private static final int P_RO_REPORT_SPEC = 237;
    private static final int P_TAG_REPORT_CONTENT_SELECTOR = 238;
    private static final int P_TAG_REPORT_DATA = 240;
    private static final int P_EPC_DATA = 241;

    // TV parameter types seen inside TagReportData, with their value sizes
    private static final int TV_ANTENNA_ID = 1;            // u16
    private static final int TV_FIRST_SEEN_UTC = 2;        // u64
    private static final int TV_FIRST_SEEN_UPTIME = 3;     // u64
    private static final int TV_LAST_SEEN_UTC = 4;         // u64
    private static final int TV_LAST_SEEN_UPTIME = 5;      // u64
    private static final int TV_PEAK_RSSI = 6;             // s8
    private static final int TV_CHANNEL_INDEX = 7;         // u16
    private static final int TV_TAG_SEEN_COUNT = 8;        // u16
    private static final int TV_ROSPEC_ID = 9;             // u32
    private static final int TV_INVENTORY_PARAM_SPEC_ID = 10; // u16
    private static final int TV_C1G2_CRC = 11;             // u16
    private static final int TV_C1G2_PC = 12;              // u16
    private static final int TV_EPC_96 = 13;               // 12 bytes
    private static final int TV_SPEC_INDEX = 14;           // u16
    private static final int TV_CLIENT_REQUEST_OP_SPEC_RESULT = 15; // u16
    private static final int TV_ACCESS_SPEC_ID = 16;       // u32

    private static final int ROSPEC_ID = 1;

    /** How often the reader is asked to send a KEEPALIVE. */
    public static final int KEEPALIVE_MS = 5000;

    private final byte[] buf = new byte[65536];
    private int size = 0;
    private int messageId = 100;
    private final ByteArrayOutputStream outbound = new ByteArrayOutputStream();
    private volatile boolean keepaliveSeen = false;
    private final boolean buffered;
    private final ReaderClock readerClock;
    private long arrivalMs;

    /** Streaming mode: the reader pushes every read as it happens. */
    public LlrpEngine() {
        this(false);
    }

    /**
     * @param buffered ask the reader to ACCUMULATE reads and hand them over
     *   when polled ({@link #getReport()}), instead of pushing each one down
     *   the socket as it happens. Pushed reads are gone if the link is down
     *   when they occur; buffered ones survive it, at the cost of arriving in
     *   polls. Recorded times are unaffected either way — they come from the
     *   reader's own FirstSeenTimestamp, not from when we received them.
     */
    public LlrpEngine(boolean buffered) {
        this(buffered, new ReaderClock());
    }

    /**
     * @param clock a mapping to go on using. Pass the same one across
     *   reconnects and the offset learned before an outage is still there when
     *   the reader's backlog arrives, instead of a brand-new mapping stamping
     *   it all at the reconnect.
     */
    public LlrpEngine(boolean buffered, ReaderClock clock) {
        this.buffered = buffered;
        this.readerClock = clock;
    }

    /** Handshake bytes to send right after the TCP connection opens. */
    public byte[] onConnect() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeAll(out, message(MSG_SET_READER_CONFIG, readerConfig()));
        if (buffered) {
            // Drain anything the reader held for us FIRST — before the DELETE
            // below tears down the ROSpec that accumulated it. The reader
            // answers in order, so the backlog is already on its way out by the
            // time the delete lands.
            writeAll(out, message(MSG_ENABLE_EVENTS_AND_REPORTS, new byte[0]));
            writeAll(out, message(MSG_GET_REPORT, new byte[0]));
        }
        writeAll(out, message(MSG_DELETE_ROSPEC, u32(0)));
        writeAll(out, message(MSG_ADD_ROSPEC, buildROSpec(buffered)));
        writeAll(out, message(MSG_ENABLE_ROSPEC, u32(ROSPEC_ID)));
        writeAll(out, message(MSG_START_ROSPEC, u32(ROSPEC_ID)));
        writeAll(out, message(MSG_ENABLE_EVENTS_AND_REPORTS, new byte[0]));
        return out.toByteArray();
    }

    /** Ask the reader to hand over everything it has accumulated. */
    public byte[] getReport() {
        return message(MSG_GET_REPORT, new byte[0]);
    }

    /**
     * True once the reader has actually sent a KEEPALIVE. Until then a quiet
     * socket is indistinguishable from a healthy one with no chips crossing,
     * so callers must not time it out.
     */
    public boolean keepaliveSeen() {
        return keepaliveSeen;
    }

    /** SET_READER_CONFIG payload: keep our settings, add a periodic keepalive. */
    private byte[] readerConfig() {
        ByteArrayOutputStream params = new ByteArrayOutputStream();
        writeAll(params, tlv(P_KEEPALIVE_SPEC, u8(1), u32(KEEPALIVE_MS))); // 1 = periodic
        if (buffered) {
            // HoldEventsAndReportsUponReconnect: on the next connection the
            // reader keeps what it has until we ask for it, instead of firing
            // it at a client that may not be ready.
            writeAll(params, tlv(P_EVENTS_AND_REPORTS, u8(0x80)));
        }
        byte[] specs = params.toByteArray();
        byte[] payload = new byte[1 + specs.length];
        payload[0] = 0; // do NOT reset the reader to factory defaults
        System.arraycopy(specs, 0, payload, 1, specs.length);
        return payload;
    }

    // ---- chip programming: write a new EPC into the tag's EPC memory bank ----
    //
    // Builds an AccessSpec whose single C1G2Write op-spec writes the new EPC
    // words into memory bank 1 starting at word 2 (past StoredCRC + PC), for
    // any tag the reader sees, then stops after one operation. Verification is
    // by re-running inventory (Read), matching the reference app's flow.

    private static final int MSG_ADD_ACCESSSPEC = 40;
    private static final int MSG_ENABLE_ACCESSSPEC = 42;
    private static final int MSG_DELETE_ACCESSSPEC = 41;

    private static final int P_ACCESS_SPEC = 207;
    private static final int P_ACCESS_SPEC_STOP_TRIGGER = 208;
    private static final int P_ACCESS_COMMAND = 209;
    private static final int P_C1G2_TAG_SPEC = 338;
    private static final int P_C1G2_TARGET_TAG = 339;
    private static final int P_C1G2_WRITE = 342;

    private static final int ACCESS_SPEC_ID = 1;

    /** DELETE + ADD (disabled) + ENABLE the write AccessSpec, ready to send. */
    public byte[] programEpc(String newEpcHex) {
        byte[] epc = hexToBytes(newEpcHex);
        int words = (epc.length + 1) / 2;
        byte[] writeData = new byte[words * 2];
        System.arraycopy(epc, 0, writeData, 0, epc.length); // zero-padded to a word

        byte[] write = tlv(P_C1G2_WRITE,
                u16(1),          // OpSpecID
                u32(0),          // access password
                u8(0x40),        // MB=1 (EPC), reserved
                u16(2),          // word pointer: skip CRC + PC
                u16(words),      // write data word count
                writeData);

        byte[] targetTag = tlv(P_C1G2_TARGET_TAG,
                u8(0x60),        // MB=1, Match=1
                u16(0x20),       // pointer to EPC (32 bits in)
                u16(0),          // mask bit count 0 -> match any
                u16(0));         // data bit count 0
        byte[] tagSpec = tlv(P_C1G2_TAG_SPEC, targetTag);
        byte[] command = tlv(P_ACCESS_COMMAND, tagSpec, write);

        byte[] stop = tlv(P_ACCESS_SPEC_STOP_TRIGGER, u8(1), u16(1)); // stop after 1 op
        byte[] accessSpec = tlv(P_ACCESS_SPEC,
                u32(ACCESS_SPEC_ID),
                u16(0),          // antenna 0 = all
                u8(1),           // protocol C1G2
                u8(0x00),        // disabled; enabled by ENABLE_ACCESSSPEC
                u32(ROSPEC_ID),  // tie to our running ROSpec
                stop, command);

        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeAll(out, message(MSG_DELETE_ACCESSSPEC, u32(ACCESS_SPEC_ID)));
        writeAll(out, message(MSG_ADD_ACCESSSPEC, accessSpec));
        writeAll(out, message(MSG_ENABLE_ACCESSSPEC, u32(ACCESS_SPEC_ID)));
        return out.toByteArray();
    }

    private static byte[] hexToBytes(String hex) {
        hex = hex.replaceAll("[^0-9A-Fa-f]", "");
        if (hex.length() % 2 != 0) hex = "0" + hex;
        byte[] out = new byte[hex.length() / 2];
        for (int i = 0; i < out.length; i++) {
            out[i] = (byte) Integer.parseInt(hex.substring(i * 2, i * 2 + 2), 16);
        }
        return out;
    }

    /** Bytes the engine wants written to the reader (keepalive ACKs). */
    public byte[] takeOutbound() {
        if (outbound.size() == 0) return new byte[0];
        byte[] pending = outbound.toByteArray();
        outbound.reset();
        return pending;
    }

    @Override
    public List<TagRead> feed(byte[] data, int length) {
        return feed(data, length, System.currentTimeMillis());
    }

    /**
     * As {@link #feed(byte[], int)}, with the moment the bytes arrived passed in
     * explicitly. One reference for the whole batch: a single socket read can
     * carry a hundred tags, and measuring each against its own "now" would
     * spread them by parse cost rather than by when they actually crossed.
     */
    List<TagRead> feed(byte[] data, int length, long arrivedAtMs) {
        List<TagRead> reads = new ArrayList<>();
        arrivalMs = arrivedAtMs;
        int offset = 0;
        while (offset < length) {
            int chunk = Math.min(length - offset, buf.length - size);
            System.arraycopy(data, offset, buf, size, chunk);
            size += chunk;
            offset += chunk;
            drain(reads);
            if (size == buf.length) size = 0; // pathological oversized frame: resync
        }
        return reads;
    }

    private void drain(List<TagRead> reads) {
        while (size >= 10) {
            int type = ((buf[0] & 0x03) << 8) | (buf[1] & 0xFF);
            long total = u32At(2);
            if (total < 10 || total > buf.length) { // corrupt header: drop a byte, resync
                System.arraycopy(buf, 1, buf, 0, size - 1);
                size -= 1;
                continue;
            }
            if (size < total) return;
            if (type == MSG_RO_ACCESS_REPORT) {
                parseReport(10, (int) total, reads);
            } else if (type == MSG_KEEPALIVE) {
                keepaliveSeen = true;
                long id = u32At(6);
                outbound.write(header(MSG_KEEPALIVE_ACK, 10, (int) id), 0, 10);
            }
            System.arraycopy(buf, (int) total, buf, 0, size - (int) total);
            size -= (int) total;
        }
    }

    // ---- RO_ACCESS_REPORT decoding ----

    private void parseReport(int pos, int end, List<TagRead> reads) {
        while (pos + 4 <= end) {
            int ptype = ((buf[pos] & 0x03) << 8) | (buf[pos + 1] & 0xFF);
            int plen = ((buf[pos + 2] & 0xFF) << 8) | (buf[pos + 3] & 0xFF);
            if (plen < 4 || pos + plen > end) return;
            if (ptype == P_TAG_REPORT_DATA) {
                TagRead read = parseTagReportData(pos + 4, pos + plen);
                if (read != null) reads.add(read);
            }
            pos += plen;
        }
    }

    private TagRead parseTagReportData(int pos, int end) {
        String epc = null;
        Double rssi = null;
        Integer antenna = null;
        Long seenUtcUs = null;
        Long seenUptimeUs = null;
        while (pos < end) {
            int first = buf[pos] & 0xFF;
            if ((first & 0x80) != 0) { // TV parameter
                int tvType = first & 0x7F;
                int valueLen = tvValueLength(tvType);
                if (valueLen < 0 || pos + 1 + valueLen > end) {
                    return finishTag(epc, rssi, antenna, seenUtcUs, seenUptimeUs);
                }
                if (tvType == TV_EPC_96) {
                    epc = hex(pos + 1, 12);
                } else if (tvType == TV_PEAK_RSSI) {
                    rssi = (double) buf[pos + 1]; // signed dBm
                } else if (tvType == TV_ANTENNA_ID) {
                    antenna = ((buf[pos + 1] & 0xFF) << 8) | (buf[pos + 2] & 0xFF); // u16
                } else if (tvType == TV_FIRST_SEEN_UTC) {
                    seenUtcUs = u64At(pos + 1);      // microseconds since epoch
                } else if (tvType == TV_FIRST_SEEN_UPTIME) {
                    seenUptimeUs = u64At(pos + 1);   // microseconds since reader boot
                }
                pos += 1 + valueLen;
            } else { // TLV parameter
                if (pos + 4 > end) break;
                int ptype = ((buf[pos] & 0x03) << 8) | (buf[pos + 1] & 0xFF);
                int plen = ((buf[pos + 2] & 0xFF) << 8) | (buf[pos + 3] & 0xFF);
                if (plen < 4 || pos + plen > end) break;
                if (ptype == P_EPC_DATA && plen >= 6) {
                    int bits = ((buf[pos + 4] & 0xFF) << 8) | (buf[pos + 5] & 0xFF);
                    int bytes = Math.min((bits + 7) / 8, plen - 6);
                    if (bytes >= 2) epc = hex(pos + 6, bytes);
                }
                pos += plen;
            }
        }
        return finishTag(epc, rssi, antenna, seenUtcUs, seenUptimeUs);
    }

    private TagRead finishTag(String epc, Double rssi, Integer antenna,
                              Long seenUtcUs, Long seenUptimeUs) {
        if (epc == null || epc.length() < 4) return null;
        return new TagRead(epc, rssi,
                readerClock.stamp(arrivalMs, seenUtcUs, seenUptimeUs), antenna);
    }

    private static int tvValueLength(int type) {
        switch (type) {
            case TV_PEAK_RSSI: return 1;
            case TV_ANTENNA_ID: case TV_CHANNEL_INDEX: case TV_TAG_SEEN_COUNT:
            case TV_INVENTORY_PARAM_SPEC_ID: case TV_C1G2_CRC: case TV_C1G2_PC:
            case TV_SPEC_INDEX: case TV_CLIENT_REQUEST_OP_SPEC_RESULT: return 2;
            case TV_ROSPEC_ID: case TV_ACCESS_SPEC_ID: return 4;
            case TV_FIRST_SEEN_UTC: case TV_FIRST_SEEN_UPTIME:
            case TV_LAST_SEEN_UTC: case TV_LAST_SEEN_UPTIME: return 8;
            case TV_EPC_96: return 12;
            default: return -1;
        }
    }

    // ---- message/parameter encoding ----

    private byte[] message(int type, byte[] payload) {
        byte[] head = header(type, 10 + payload.length, messageId++);
        byte[] msg = new byte[head.length + payload.length];
        System.arraycopy(head, 0, msg, 0, head.length);
        System.arraycopy(payload, 0, msg, head.length, payload.length);
        return msg;
    }

    private static byte[] header(int type, int totalLen, int id) {
        return new byte[]{
                (byte) (0x04 | ((type >> 8) & 0x03)), (byte) type, // ver=1, type
                (byte) (totalLen >>> 24), (byte) (totalLen >>> 16), (byte) (totalLen >>> 8), (byte) totalLen,
                (byte) (id >>> 24), (byte) (id >>> 16), (byte) (id >>> 8), (byte) id,
        };
    }

    private static byte[] tlv(int type, byte[]... parts) {
        int length = 4;
        for (byte[] part : parts) length += part.length;
        byte[] out = new byte[length];
        out[0] = (byte) ((type >> 8) & 0x03);
        out[1] = (byte) type;
        out[2] = (byte) (length >>> 8);
        out[3] = (byte) length;
        int at = 4;
        for (byte[] part : parts) {
            System.arraycopy(part, 0, out, at, part.length);
            at += part.length;
        }
        return out;
    }

    private static byte[] buildROSpec(boolean buffered) {
        byte[] startTrigger = tlv(P_ROSPEC_START_TRIGGER, u8(0));            // null: started explicitly
        byte[] stopTrigger = tlv(P_ROSPEC_STOP_TRIGGER, u8(0), u32(0));      // never stops
        byte[] boundary = tlv(P_RO_BOUNDARY_SPEC, startTrigger, stopTrigger);

        byte[] aiStop = tlv(P_AISPEC_STOP_TRIGGER, u8(0), u32(0));           // inventory forever
        byte[] invParam = tlv(P_INVENTORY_PARAMETER_SPEC, u16(1), u8(1));    // id=1, EPCGlobal C1G2
        byte[] aiSpec = tlv(P_AISPEC, u16(1), u16(0), aiStop, invParam);     // 1 entry, antenna 0 = all

        // include AntennaID + PeakRSSI + FirstSeenTimestamp
        byte[] selector = tlv(P_TAG_REPORT_CONTENT_SELECTOR, u16(0x1600));
        // Trigger 0 = report only when asked, so reads pile up in the reader
        // and outlive a broken link. Trigger 1 with N=1 = push every tag the
        // instant it is seen, which is lost if nothing is listening.
        byte[] reportSpec = buffered
                ? tlv(P_RO_REPORT_SPEC, u8(0), u16(0), selector)
                : tlv(P_RO_REPORT_SPEC, u8(1), u16(1), selector);

        return tlv(P_ROSPEC, u32(ROSPEC_ID), u8(0) /* priority */, u8(0) /* Disabled */,
                boundary, aiSpec, reportSpec);
    }

    private static byte[] u8(int v) { return new byte[]{(byte) v}; }
    private static byte[] u16(int v) { return new byte[]{(byte) (v >>> 8), (byte) v}; }
    private static byte[] u32(int v) {
        return new byte[]{(byte) (v >>> 24), (byte) (v >>> 16), (byte) (v >>> 8), (byte) v};
    }

    private long u64At(int pos) {
        long v = 0;
        for (int i = 0; i < 8; i++) v = (v << 8) | (buf[pos + i] & 0xFF);
        return v;
    }

    private long u32At(int pos) {
        return ((long) (buf[pos] & 0xFF) << 24) | ((buf[pos + 1] & 0xFF) << 16)
                | ((buf[pos + 2] & 0xFF) << 8) | (buf[pos + 3] & 0xFF);
    }

    private String hex(int pos, int len) {
        StringBuilder sb = new StringBuilder(len * 2);
        for (int i = 0; i < len; i++) sb.append(String.format("%02X", buf[pos + i] & 0xFF));
        return sb.toString();
    }

    private static void writeAll(ByteArrayOutputStream out, byte[] bytes) {
        out.write(bytes, 0, bytes.length);
    }

    /**
     * Maps the reader's own clock onto the device clock, so a read is stamped
     * when the tag crossed rather than when this app parsed the bytes.
     *
     * Why an offset and not the reader's time directly: the reader sits on a
     * router with no internet uplink, so its UTC clock has never been set. Its
     * absolute value is meaningless — often zero, and an unsynced reader is
     * meant to send uptime-since-boot instead. What it CAN be trusted for is
     * ticking, so only the difference between the two clocks is used, which
     * makes the absolute value irrelevant and lets uptime work identically.
     *
     * The offset is the MINIMUM of (arrival - reader time) over recent reads:
     * the least-delayed read carries the least buffering, and a buffered burst
     * has a large difference, so it can never drag the estimate. The minimum is
     * kept over two rotating windows rather than for the whole connection, so
     * drift between the two crystals cannot accumulate over a long race.
     *
     * Nothing is trusted until the reader's clock has proved it advances at the
     * same rate as ours. The failure this guards against is a reader reporting a
     * CONSTANT timestamp: every read would map to one instant, which is far
     * worse than today. Until then, and whenever the answer looks impossible,
     * the arrival time is returned — exactly the old behaviour.
     */
    public static final class ReaderClock {
        private static final int SRC_NONE = 0, SRC_UTC = 1, SRC_UPTIME = 2;

        /** Rotate the minimum this often, bounding how stale the offset can be. */
        private static final long WINDOW_MS = 60_000;
        /** A read no later than this past the offset counts as promptly delivered. */
        private static final long PROMPT_MS = 1000;
        private static final int MIN_SAMPLES = 8;
        private static final long MIN_SPAN_MS = 10_000;
        /**
         * Furthest back a corrected time may land. This has to cover the whole
         * window the service is willing to wait on a silent link before it
         * rebuilds the connection, because everything the reader buffered
         * during an outage arrives at the end of it — clamp tighter and the
         * recovered reads would be thrown back to their arrival time, which is
         * the very thing this class exists to stop.
         */
        private static final long MAX_LAG_MS = 120_000;
        /** A read cannot have happened meaningfully after we parsed it. */
        private static final long MAX_LEAD_MS = 250;

        private int source = SRC_NONE;
        private boolean trusted;

        private long curMin = Long.MAX_VALUE;
        private long prevMin = Long.MAX_VALUE;
        private long windowStart;
        private boolean started;

        private int prompt;
        private long anchorArrival;
        private long anchorReader;

        /** Device-clock time for one read; falls back to arrival when unsure. */
        synchronized long stamp(long arrival, Long seenUtcUs, Long seenUptimeUs) {
            // Lock onto one source for the connection. Feeding an uptime value
            // through a UTC-derived offset (or the reverse) would be wildly
            // wrong, so a reader that reports both must not be allowed to
            // alternate between them.
            if (source == SRC_NONE) {
                if (seenUtcUs != null) source = SRC_UTC;
                else if (seenUptimeUs != null) source = SRC_UPTIME;
                else return arrival;
            }
            Long us = source == SRC_UTC ? seenUtcUs : seenUptimeUs;
            if (us == null) return arrival; // this read lost the field: don't guess
            long readerMs = us / 1000;

            long delta = arrival - readerMs;
            rotate(arrival);
            if (delta < curMin) curMin = delta;
            long offset = Math.min(curMin, prevMin);

            // Validate on promptly-delivered reads only. A buffered read is
            // late by definition, so letting it speak here would make a healthy
            // reader look like a drifting one every time the link hiccuped.
            if (delta <= offset + PROMPT_MS) {
                if (prompt == 0) { anchorArrival = arrival; anchorReader = readerMs; }
                prompt++;
                long ours = arrival - anchorArrival;
                long theirs = readerMs - anchorReader;
                // A frozen clock never passes this: its span stays 0 while ours grows.
                trusted = prompt >= MIN_SAMPLES && ours >= MIN_SPAN_MS
                        && Math.abs(theirs - ours) <= ours / 50 + 100;
            }
            if (!trusted) return arrival;

            long corrected = readerMs + offset;
            if (corrected > arrival + MAX_LEAD_MS) return arrival;
            if (corrected < arrival - MAX_LAG_MS) return arrival;
            return corrected;
        }

        private void rotate(long arrival) {
            if (!started) { started = true; windowStart = arrival; return; }
            if (arrival - windowStart < WINDOW_MS) return;
            prevMin = curMin;
            curMin = Long.MAX_VALUE;
            windowStart = arrival;
        }
    }
}
