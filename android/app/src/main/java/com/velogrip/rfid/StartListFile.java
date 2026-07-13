package com.velogrip.rfid;

import com.velogrip.rfid.db.RaceStore;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * On-device start-list import: reads the same .xlsx (Webscorer export) and
 * .csv files the website accepts, with the same header names (en + he), so a
 * file copied to the phone works with zero connectivity.
 */
public final class StartListFile {

    public static final class Row {
        public String bib = "", name = "", category = "", wave = "", epc = "", epc2 = "", distance = "", gender = "", team = "";
    }

    public static final class ImportResult {
        public final int racers, waves, skipped;
        ImportResult(int racers, int waves, int skipped) {
            this.racers = racers; this.waves = waves; this.skipped = skipped;
        }
    }

    private static final Map<String, String[]> HEADERS = new HashMap<>();
    static {
        HEADERS.put("bib", new String[]{"bib", "number", "num", "#", "מספר", "מספר חזה", "חזה"});
        HEADERS.put("name", new String[]{"name", "participant", "racer", "שם", "שם מלא"});
        HEADERS.put("category", new String[]{"category", "cat", "קטגוריה"});
        HEADERS.put("wave", new String[]{"wave", "heat", "מקצה"});
        HEADERS.put("epc", new String[]{"epc", "chip", "tag", "chip id", "chipid", "שבב", "תג"});
        HEADERS.put("epc2", new String[]{"chip id2", "chipid2", "epc2", "chip 2", "שבב 2"});
        HEADERS.put("distance", new String[]{"distance", "מרחק"});
        HEADERS.put("gender", new String[]{"gender", "sex", "מין", "מגדר"});
        HEADERS.put("team", new String[]{"team", "team name", "club", "קבוצה", "שם קבוצה", "מועדון"});
    }

    private StartListFile() { }

    public static List<Row> parse(InputStream in) throws Exception {
        ByteArrayOutputStream buf = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = in.read(chunk)) > 0) buf.write(chunk, 0, n);
        byte[] bytes = buf.toByteArray();
        boolean xlsx = bytes.length > 3 && bytes[0] == 'P' && bytes[1] == 'K';
        List<List<String>> rows = xlsx ? parseXlsx(bytes) : parseCsv(bytes);
        return mapRows(rows);
    }

    /** Loads the parsed rows into the local store; either chip counts once. */
    public static ImportResult importInto(RaceStore store, List<Row> rows) {
        int racers = 0, skipped = 0;
        LinkedHashSet<String> waves = new LinkedHashSet<>();
        for (Row r : rows) {
            String epc = r.epc.toUpperCase(Locale.US).replaceAll("[^0-9A-F]", "");
            if (epc.isEmpty()) {
                if (!r.bib.matches("\\d{1,10}")) { skipped++; continue; }
                epc = "AA" + (r.bib.length() >= 4 ? r.bib
                        : String.format(Locale.US, "%4s", r.bib).replace(' ', '0'));
            }
            if (!r.wave.isEmpty()) waves.add(r.wave);
            store.upsertRacer(new RaceStore.Racer(epc, r.bib, r.name, r.category, r.wave, r.distance, "", r.gender, r.team));
            String epc2 = r.epc2.toUpperCase(Locale.US).replaceAll("[^0-9A-F]", "");
            if (!epc2.isEmpty() && !r.bib.isEmpty()) {
                store.upsertRacer(new RaceStore.Racer(epc2, r.bib, r.name, r.category, r.wave, r.distance, "", r.gender, r.team));
            }
            racers++;
        }
        for (String w : waves) {
            if (store.wave(w) == null) store.upsertWave(w, null, false);
        }
        return new ImportResult(racers, waves.size(), skipped);
    }

    // ---- header mapping (same rules as the website importer) ----

    private static List<Row> mapRows(List<List<String>> rows) {
        List<Row> out = new ArrayList<>();
        if (rows.isEmpty()) return out;
        Map<String, Integer> cols = new HashMap<>();
        List<String> header = rows.get(0);
        for (Map.Entry<String, String[]> field : HEADERS.entrySet()) {
            for (int i = 0; i < header.size(); i++) {
                String h = header.get(i).trim().toLowerCase(Locale.US);
                for (String candidate : field.getValue()) {
                    if (h.equals(candidate)) { cols.put(field.getKey(), i); break; }
                }
                if (cols.containsKey(field.getKey())) break;
            }
        }
        boolean hasHeader = !cols.isEmpty();
        if (!hasHeader) {
            cols.put("bib", 0); cols.put("name", 1); cols.put("category", 2);
            cols.put("wave", 3); cols.put("epc", 4);
        }
        for (int i = hasHeader ? 1 : 0; i < rows.size(); i++) {
            List<String> cells = rows.get(i);
            Row r = new Row();
            r.bib = cell(cells, cols.get("bib"));
            r.name = cell(cells, cols.get("name"));
            r.category = cell(cells, cols.get("category"));
            r.wave = cell(cells, cols.get("wave"));
            r.epc = cell(cells, cols.get("epc"));
            r.epc2 = cell(cells, cols.get("epc2"));
            r.distance = cell(cells, cols.get("distance"));
            r.gender = cell(cells, cols.get("gender"));
            r.team = cell(cells, cols.get("team"));
            if (!r.name.isEmpty() || !r.bib.isEmpty()) out.add(r);
        }
        return out;
    }

    private static String cell(List<String> cells, Integer idx) {
        if (idx == null || idx < 0 || idx >= cells.size()) return "";
        String v = cells.get(idx);
        return v == null ? "" : v.trim();
    }

    // ---- csv ----

    private static List<List<String>> parseCsv(byte[] bytes) {
        String text = new String(bytes, StandardCharsets.UTF_8);
        if (!text.isEmpty() && text.charAt(0) == '\uFEFF') text = text.substring(1);
        String firstLine = text.split("\n", 2)[0];
        char delimiter = ',';
        int best = firstLine.split(",", -1).length;
        for (char d : new char[]{';', '\t'}) {
            int count = firstLine.split(String.valueOf(d), -1).length;
            if (count > best) { best = count; delimiter = d; }
        }
        List<List<String>> rows = new ArrayList<>();
        List<String> cells = new ArrayList<>();
        StringBuilder cur = new StringBuilder();
        boolean inQuotes = false;
        for (int i = 0; i < text.length(); i++) {
            char ch = text.charAt(i);
            if (inQuotes) {
                if (ch == '"' && i + 1 < text.length() && text.charAt(i + 1) == '"') {
                    cur.append('"'); i++;
                } else if (ch == '"') {
                    inQuotes = false;
                } else {
                    cur.append(ch);
                }
            } else if (ch == '"') {
                inQuotes = true;
            } else if (ch == delimiter) {
                cells.add(cur.toString()); cur.setLength(0);
            } else if (ch == '\n' || ch == '\r') {
                if (ch == '\r' && i + 1 < text.length() && text.charAt(i + 1) == '\n') i++;
                cells.add(cur.toString()); cur.setLength(0);
                if (cells.size() > 1 || !cells.get(0).trim().isEmpty()) rows.add(cells);
                cells = new ArrayList<>();
            } else {
                cur.append(ch);
            }
        }
        cells.add(cur.toString());
        if (cells.size() > 1 || !cells.get(0).trim().isEmpty()) rows.add(cells);
        return rows;
    }

    // ---- xlsx (ZIP + regex XML, mirrors server/xlsx.js) ----

    private static final Pattern SI = Pattern.compile("<si[ >].*?</si>", Pattern.DOTALL);
    private static final Pattern T = Pattern.compile("<t(?: [^>]*)?>(.*?)</t>", Pattern.DOTALL);
    private static final Pattern ROW = Pattern.compile("<row[ >].*?</row>", Pattern.DOTALL);
    private static final Pattern CELL =
            Pattern.compile("<c ([^>]*?)(?:/>|>(.*?)</c>)", Pattern.DOTALL);
    private static final Pattern V = Pattern.compile("<v(?: [^>]*)?>(.*?)</v>", Pattern.DOTALL);

    private static List<List<String>> parseXlsx(byte[] bytes) throws Exception {
        String sharedXml = null, sheetXml = null, sheetName = null;
        ZipInputStream zip = new ZipInputStream(new ByteArrayInputStream(bytes));
        ZipEntry entry;
        while ((entry = zip.getNextEntry()) != null) {
            String name = entry.getName();
            if (name.equals("xl/sharedStrings.xml")) {
                sharedXml = readEntry(zip);
            } else if (name.startsWith("xl/worksheets/sheet") && name.endsWith(".xml")) {
                if (sheetName == null || name.compareTo(sheetName) < 0) {
                    sheetName = name;
                    sheetXml = readEntry(zip);
                }
            }
        }
        zip.close();
        if (sheetXml == null) throw new Exception("no worksheet in file");

        List<String> shared = new ArrayList<>();
        if (sharedXml != null) {
            Matcher si = SI.matcher(sharedXml);
            while (si.find()) {
                StringBuilder sb = new StringBuilder();
                Matcher t = T.matcher(si.group());
                while (t.find()) sb.append(decodeEntities(t.group(1)));
                shared.add(sb.toString());
            }
        }

        List<List<String>> rows = new ArrayList<>();
        Matcher rowM = ROW.matcher(sheetXml);
        while (rowM.find()) {
            List<String> cells = new ArrayList<>();
            Matcher cellM = CELL.matcher(rowM.group());
            while (cellM.find()) {
                String attrs = cellM.group(1);
                String body = cellM.group(2) == null ? "" : cellM.group(2);
                int col = colIndex(attr(attrs, "r"));
                String type = attr(attrs, "t");
                String value = "";
                if ("s".equals(type)) {
                    Matcher v = V.matcher(body);
                    if (v.find()) {
                        int idx = Integer.parseInt(v.group(1).trim());
                        if (idx >= 0 && idx < shared.size()) value = shared.get(idx);
                    }
                } else if ("inlineStr".equals(type)) {
                    StringBuilder sb = new StringBuilder();
                    Matcher t = T.matcher(body);
                    while (t.find()) sb.append(decodeEntities(t.group(1)));
                    value = sb.toString();
                } else {
                    Matcher v = V.matcher(body);
                    if (v.find()) value = decodeEntities(v.group(1));
                    // trim Excel's float rendering of integers (100.0 -> 100)
                    if (value.matches("\\d+\\.0+")) value = value.substring(0, value.indexOf('.'));
                }
                while (cells.size() < col) cells.add("");
                cells.add(value);
            }
            if (!cells.isEmpty()) rows.add(cells);
        }
        return rows;
    }

    private static String readEntry(ZipInputStream zip) throws Exception {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] chunk = new byte[8192];
        int n;
        while ((n = zip.read(chunk)) > 0) out.write(chunk, 0, n);
        return new String(out.toByteArray(), StandardCharsets.UTF_8);
    }

    private static String attr(String attrs, String name) {
        Matcher m = Pattern.compile(name + "=\"([^\"]*)\"").matcher(attrs);
        return m.find() ? m.group(1) : "";
    }

    /** "B7" -> 1. Missing ref means "next cell" — approximated as append. */
    private static int colIndex(String ref) {
        int col = 0;
        for (int i = 0; i < ref.length(); i++) {
            char ch = ref.charAt(i);
            if (ch >= 'A' && ch <= 'Z') col = col * 26 + (ch - 'A' + 1);
            else break;
        }
        return Math.max(0, col - 1);
    }

    private static String decodeEntities(String s) {
        StringBuilder out = new StringBuilder(s.length());
        for (int i = 0; i < s.length(); i++) {
            char ch = s.charAt(i);
            if (ch != '&') { out.append(ch); continue; }
            int end = s.indexOf(';', i);
            if (end < 0) { out.append(ch); continue; }
            String ent = s.substring(i + 1, end);
            i = end;
            switch (ent) {
                case "amp": out.append('&'); break;
                case "lt": out.append('<'); break;
                case "gt": out.append('>'); break;
                case "quot": out.append('"'); break;
                case "apos": out.append('\''); break;
                default:
                    try {
                        out.appendCodePoint(ent.startsWith("#x") || ent.startsWith("#X")
                                ? Integer.parseInt(ent.substring(2), 16)
                                : ent.startsWith("#") ? Integer.parseInt(ent.substring(1))
                                : '&');
                        if (!ent.startsWith("#")) out.append(ent).append(';');
                    } catch (NumberFormatException e) {
                        out.append('&').append(ent).append(';');
                    }
            }
        }
        return out.toString();
    }
}
