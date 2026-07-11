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
 *   DELETE_ROSPEC(0)  — clear anything a previous session left behind
 *   ADD_ROSPEC        — null start/stop triggers, all antennas, report per tag
 *   ENABLE_ROSPEC
 *   START_ROSPEC
 *   ENABLE_EVENTS_AND_REPORTS
 *
 * Incoming RO_ACCESS_REPORT messages are decoded into TagReads (EPC-96 or
 * EPCData, PeakRSSI when present). KEEPALIVEs are acknowledged so the reader
 * does not drop the connection. All other messages (responses, reader event
 * notifications) are skipped by length.
 *
 * Wire formats:
 *   message header:  u16 (rsvd:3 ver:3 type:10) | u32 total length | u32 id
 *   TLV parameter:   u16 (rsvd:6 type:10) | u16 length | value
 *   TV parameter:    u8  (1:1 type:7) | fixed-size value
 */
public final class LlrpEngine implements TagParser {

    // message types
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

    private final byte[] buf = new byte[65536];
    private int size = 0;
    private int messageId = 100;
    private final ByteArrayOutputStream outbound = new ByteArrayOutputStream();

    /** Handshake bytes to send right after the TCP connection opens. */
    public byte[] onConnect() {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        writeAll(out, message(MSG_DELETE_ROSPEC, u32(0)));
        writeAll(out, message(MSG_ADD_ROSPEC, buildROSpec()));
        writeAll(out, message(MSG_ENABLE_ROSPEC, u32(ROSPEC_ID)));
        writeAll(out, message(MSG_START_ROSPEC, u32(ROSPEC_ID)));
        writeAll(out, message(MSG_ENABLE_EVENTS_AND_REPORTS, new byte[0]));
        return out.toByteArray();
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
        List<TagRead> reads = new ArrayList<>();
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
        while (pos < end) {
            int first = buf[pos] & 0xFF;
            if ((first & 0x80) != 0) { // TV parameter
                int tvType = first & 0x7F;
                int valueLen = tvValueLength(tvType);
                if (valueLen < 0 || pos + 1 + valueLen > end) return finishTag(epc, rssi);
                if (tvType == TV_EPC_96) {
                    epc = hex(pos + 1, 12);
                } else if (tvType == TV_PEAK_RSSI) {
                    rssi = (double) buf[pos + 1]; // signed dBm
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
        return finishTag(epc, rssi);
    }

    private TagRead finishTag(String epc, Double rssi) {
        if (epc == null || epc.length() < 4) return null;
        return new TagRead(epc, rssi, System.currentTimeMillis());
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

    private static byte[] buildROSpec() {
        byte[] startTrigger = tlv(P_ROSPEC_START_TRIGGER, u8(0));            // null: started explicitly
        byte[] stopTrigger = tlv(P_ROSPEC_STOP_TRIGGER, u8(0), u32(0));      // never stops
        byte[] boundary = tlv(P_RO_BOUNDARY_SPEC, startTrigger, stopTrigger);

        byte[] aiStop = tlv(P_AISPEC_STOP_TRIGGER, u8(0), u32(0));           // inventory forever
        byte[] invParam = tlv(P_INVENTORY_PARAMETER_SPEC, u16(1), u8(1));    // id=1, EPCGlobal C1G2
        byte[] aiSpec = tlv(P_AISPEC, u16(1), u16(0), aiStop, invParam);     // 1 entry, antenna 0 = all

        // report every tag; include AntennaID + PeakRSSI + FirstSeenTimestamp
        byte[] selector = tlv(P_TAG_REPORT_CONTENT_SELECTOR, u16(0x1600));
        byte[] reportSpec = tlv(P_RO_REPORT_SPEC, u8(1), u16(1), selector);

        return tlv(P_ROSPEC, u32(ROSPEC_ID), u8(0) /* priority */, u8(0) /* Disabled */,
                boundary, aiSpec, reportSpec);
    }

    private static byte[] u8(int v) { return new byte[]{(byte) v}; }
    private static byte[] u16(int v) { return new byte[]{(byte) (v >>> 8), (byte) v}; }
    private static byte[] u32(int v) {
        return new byte[]{(byte) (v >>> 24), (byte) (v >>> 16), (byte) (v >>> 8), (byte) v};
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
}
