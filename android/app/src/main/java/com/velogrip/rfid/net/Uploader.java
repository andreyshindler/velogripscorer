package com.velogrip.rfid.net;

import com.velogrip.rfid.db.RaceStore;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.List;
import java.util.Locale;
import java.util.TimeZone;

/**
 * Web sync for the standalone timing app: batch-uploads passings and gun times
 * to the VeloGripScorer ingestion API and downloads the start list — all
 * authenticated by the reader device token, over the device's default network
 * (cellular or internet-bearing WiFi), independent of the reader-WiFi socket
 * which is bound to the RFID router's network. The race itself never depends
 * on any of these calls succeeding.
 */
public final class Uploader {

    private final String serverUrl;
    private final String readerToken;
    private final SimpleDateFormat iso;

    public Uploader(String serverUrl, String readerToken) {
        this.serverUrl = serverUrl;
        this.readerToken = readerToken;
        this.iso = new SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US);
        this.iso.setTimeZone(TimeZone.getTimeZone("UTC"));
    }

    /** Uploads a batch of passings; returns true when the server acknowledged it. */
    public boolean upload(List<RaceStore.Passing> batch) throws IOException {
        StringBuilder json = new StringBuilder("{\"reads\":[");
        for (int i = 0; i < batch.size(); i++) {
            RaceStore.Passing row = batch.get(i);
            if (i > 0) json.append(',');
            json.append("{\"epc\":\"").append(row.epc).append('"');
            if (row.rssi != null) json.append(",\"rssi\":").append(row.rssi);
            if (row.antenna != null) json.append(",\"antenna\":").append(row.antenna);
            json.append(",\"read_at\":\"").append(iso.format(new Date(row.readAtMs))).append("\"}");
        }
        json.append("]}");
        int code = post("/api/ingest/reads", json.toString());
        if (code == 401) throw new IOException("server rejected reader token (401)");
        return code >= 200 && code < 300;
    }

    /** Uploads a locally recorded gun time. The phone is the authoritative timer,
     *  so we force the server to take this gun time even if it already had one
     *  (e.g. after a race restart re-guns the wave a few minutes later). */
    public boolean uploadWaveStart(String name, long startedAtMs) throws IOException {
        String json = "{\"name\":" + jsonString(name)
                + ",\"started_at\":\"" + iso.format(new Date(startedAtMs)) + "\""
                + ",\"force\":true}";
        int code = post("/api/ingest/wave-start", json);
        if (code == 401) throw new IOException("server rejected reader token (401)");
        return code >= 200 && code < 300;
    }

    /** Downloads the start list JSON (racers, waves, timing settings). */
    public String downloadStartList() throws IOException {
        HttpURLConnection conn = open("/api/ingest/startlist", "GET");
        int code = conn.getResponseCode();
        String body = readBody(conn, code);
        conn.disconnect();
        if (code != 200) throw new IOException("HTTP " + code + ": " + body);
        return body;
    }

    /** Verifies server + token; returns the server's description of this reader. */
    public String ping() throws IOException {
        HttpURLConnection conn = open("/api/ingest/ping", "GET");
        int code = conn.getResponseCode();
        String body = readBody(conn, code);
        conn.disconnect();
        if (code != 200) throw new IOException("HTTP " + code + ": " + body);
        return body;
    }

    private int post(String path, String json) throws IOException {
        HttpURLConnection conn = open(path, "POST");
        byte[] body = json.getBytes(StandardCharsets.UTF_8);
        conn.setDoOutput(true);
        conn.setFixedLengthStreamingMode(body.length);
        OutputStream os = conn.getOutputStream();
        try {
            os.write(body);
        } finally {
            os.close();
        }
        int code = conn.getResponseCode();
        conn.disconnect();
        return code;
    }

    private static String readBody(HttpURLConnection conn, int code) throws IOException {
        InputStream is = code < 400 ? conn.getInputStream() : conn.getErrorStream();
        StringBuilder sb = new StringBuilder();
        if (is != null) {
            BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
            try {
                String line;
                while ((line = reader.readLine()) != null && sb.length() < 262144) sb.append(line);
            } finally {
                reader.close();
            }
        }
        return sb.toString();
    }

    private static String jsonString(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            if (c == '"' || c == '\\') sb.append('\\').append(c);
            else if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
            else sb.append(c);
        }
        return sb.append('"').toString();
    }

    /** Logs into the web account; returns the response JSON (token + user). */
    public static String login(String serverUrl, String email, String password) throws IOException {
        HttpURLConnection conn = openStatic(serverUrl, "/api/auth/login", "POST", null);
        byte[] body = ("{\"email\":" + jsonString(email) + ",\"password\":" + jsonString(password) + "}")
                .getBytes(StandardCharsets.UTF_8);
        conn.setDoOutput(true);
        conn.setFixedLengthStreamingMode(body.length);
        OutputStream os = conn.getOutputStream();
        try {
            os.write(body);
        } finally {
            os.close();
        }
        int code = conn.getResponseCode();
        String response = readBody(conn, code);
        conn.disconnect();
        if (code != 200) throw new IOException("HTTP " + code + ": " + response);
        return response;
    }

    /** Lists the account's races (each carries its app pairing token). */
    public static String myRaces(String serverUrl, String jwt) throws IOException {
        HttpURLConnection conn = openStatic(serverUrl, "/api/my/races", "GET", jwt);
        int code = conn.getResponseCode();
        String response = readBody(conn, code);
        conn.disconnect();
        if (code != 200) throw new IOException("HTTP " + code + ": " + response);
        return response;
    }

    private static HttpURLConnection openStatic(String serverUrl, String path, String method,
                                                String bearer) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(serverUrl.replaceAll("/+$", "") + path).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(10_000);
        conn.setReadTimeout(15_000);
        conn.setRequestProperty("Content-Type", "application/json");
        if (bearer != null) conn.setRequestProperty("Authorization", "Bearer " + bearer);
        return conn;
    }

    private HttpURLConnection open(String path, String method) throws IOException {
        HttpURLConnection conn = (HttpURLConnection) new URL(serverUrl + path).openConnection();
        conn.setRequestMethod(method);
        conn.setConnectTimeout(10_000);
        conn.setReadTimeout(15_000);
        conn.setRequestProperty("Content-Type", "application/json");
        conn.setRequestProperty("X-Reader-Token", readerToken);
        return conn;
    }
}
