package com.velogrip.rfid.protocol;

import com.velogrip.rfid.TagRead;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Parser for readers/timing boxes that stream one record per line, e.g.
 *   E28011606000020123456789
 *   TAG,E28011606000020123456789,-54.2
 *   epc=E2801160...;rssi=-61
 * Strategy: split on CR/LF, take the longest hex token (>= 8 chars) as the
 * EPC, and the first number that looks like a negative dBm value as RSSI.
 */
public final class AsciiLineParser implements TagParser {

    private static final Pattern HEX = Pattern.compile("\\b[0-9A-Fa-f]{8,64}\\b");
    private static final Pattern RSSI = Pattern.compile("(-\\d{1,3}(?:\\.\\d+)?)");
    private static final int MAX_LINE = 4096;

    private final StringBuilder buffer = new StringBuilder();

    @Override
    public List<TagRead> feed(byte[] data, int length) {
        List<TagRead> out = new ArrayList<>();
        for (int i = 0; i < length; i++) {
            char c = (char) (data[i] & 0xFF);
            if (c == '\n' || c == '\r') {
                if (buffer.length() > 0) {
                    TagRead read = parseLine(buffer.toString());
                    if (read != null) out.add(read);
                    buffer.setLength(0);
                }
            } else if (buffer.length() < MAX_LINE) {
                buffer.append(c);
            } else {
                buffer.setLength(0); // runaway line without terminator: drop it
            }
        }
        return out;
    }

    private TagRead parseLine(String line) {
        Matcher m = HEX.matcher(line);
        String epc = null;
        while (m.find()) {
            String candidate = m.group();
            // Prefer the longest hex run: timestamps/counters are usually shorter.
            if (epc == null || candidate.length() > epc.length()) epc = candidate;
        }
        if (epc == null) return null;
        Double rssi = null;
        Matcher r = RSSI.matcher(line);
        if (r.find()) {
            try {
                double v = Double.parseDouble(r.group(1));
                if (v >= -120 && v <= -10) rssi = v;
            } catch (NumberFormatException ignored) { }
        }
        return new TagRead(epc.toUpperCase(), rssi, System.currentTimeMillis());
    }
}
