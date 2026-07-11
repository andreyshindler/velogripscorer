package com.velogrip.rfid.protocol;

import com.velogrip.rfid.TagRead;

import java.util.ArrayList;
import java.util.List;

/**
 * Parser for the widely-cloned UHF reader binary protocol (Impinj-module based
 * readers from Chafon, Rodinbell, Hopeland clones, etc.) used in real-time
 * inventory mode:
 *
 *   frame := 0xA0 len addr cmd data... checksum
 *   len   := number of bytes after the len byte itself (addr + cmd + data + checksum)
 *   checksum := two's complement of the sum of all preceding bytes (incl. 0xA0)
 *
 * Real-time tag notifications (cmd 0x89 or 0x8B) carry:
 *   data := freqAnt(1) PC(2) EPC(n) RSSI(1)
 * where RSSI is encoded as an unsigned byte, actual dBm = value - 129.
 *
 * Frames with other command codes (heartbeats, command acks) are skipped.
 */
public final class UhfFrameParser implements TagParser {

    private static final int HEAD = 0xA0;
    private static final int MAX_FRAME = 256;

    private final byte[] buf = new byte[4096];
    private int size = 0;

    @Override
    public List<TagRead> feed(byte[] data, int length) {
        List<TagRead> out = new ArrayList<>();
        for (int i = 0; i < length; i++) {
            if (size >= buf.length) size = 0; // overflow safety: resync
            buf[size++] = data[i];
            drain(out);
        }
        return out;
    }

    private void drain(List<TagRead> out) {
        while (true) {
            // resync to frame head
            int start = 0;
            while (start < size && (buf[start] & 0xFF) != HEAD) start++;
            if (start > 0) {
                System.arraycopy(buf, start, buf, 0, size - start);
                size -= start;
            }
            if (size < 2) return;
            int len = buf[1] & 0xFF;
            if (len < 3 || len > MAX_FRAME) { // implausible: skip this head byte
                System.arraycopy(buf, 1, buf, 0, size - 1);
                size -= 1;
                continue;
            }
            int total = 2 + len; // head + len byte + len payload bytes
            if (size < total) return; // wait for more data

            int sum = 0;
            for (int i = 0; i < total - 1; i++) sum += buf[i] & 0xFF;
            int expected = (~sum + 1) & 0xFF;
            int checksum = buf[total - 1] & 0xFF;
            if (checksum == expected) {
                int cmd = buf[3] & 0xFF;
                if (cmd == 0x89 || cmd == 0x8B) {
                    TagRead read = decodeTag(total);
                    if (read != null) out.add(read);
                }
                System.arraycopy(buf, total, buf, 0, size - total);
                size -= total;
            } else {
                // bad checksum: discard the head byte and resync
                System.arraycopy(buf, 1, buf, 0, size - 1);
                size -= 1;
            }
        }
    }

    private TagRead decodeTag(int total) {
        // layout: [0]=A0 [1]=len [2]=addr [3]=cmd [4]=freqAnt [5..6]=PC [7..n-2]=EPC [n-1... wait]
        // data section runs from index 4 to total-2 inclusive; EPC = data minus freqAnt+PC+RSSI.
        int dataStart = 4;
        int dataEnd = total - 1; // exclusive of checksum
        int epcStart = dataStart + 3; // skip freqAnt + PC(2)
        int epcEnd = dataEnd - 1;     // last data byte is RSSI
        if (epcEnd - epcStart < 4) return null; // EPC shorter than 4 bytes: not a tag frame
        StringBuilder epc = new StringBuilder();
        for (int i = epcStart; i < epcEnd; i++) {
            epc.append(String.format("%02X", buf[i] & 0xFF));
        }
        double rssi = (buf[epcEnd] & 0xFF) - 129.0;
        return new TagRead(epc.toString(), rssi, System.currentTimeMillis());
    }
}
