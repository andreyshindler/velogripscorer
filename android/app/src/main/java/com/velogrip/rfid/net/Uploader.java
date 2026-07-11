package com.velogrip.rfid.net;

import com.velogrip.rfid.db.ReadQueue;

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
 * Batch-uploads queued reads to the VeloGripScorer ingestion API over the
 * device's default network (cellular or internet-bearing WiFi), independent of
 * the reader-WiFi socket which is bound to the RFID router's network.
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

    /** Uploads a batch; returns true when the server acknowledged it. */
    public boolean upload(List<ReadQueue.Row> batch) throws IOException {
        StringBuilder json = new StringBuilder("{\"reads\":[");
        for (int i = 0; i < batch.size(); i++) {
            ReadQueue.Row row = batch.get(i);
            if (i > 0) json.append(',');
            json.append("{\"epc\":\"").append(row.epc).append('"');
            if (row.rssi != null) json.append(",\"rssi\":").append(row.rssi);
            json.append(",\"read_at\":\"").append(iso.format(new Date(row.readAtMs))).append("\"}");
        }
        json.append("]}");

        HttpURLConnection conn = open("/api/ingest/reads", "POST");
        byte[] body = json.toString().getBytes(StandardCharsets.UTF_8);
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
        if (code == 401) throw new IOException("server rejected reader token (401)");
        return code >= 200 && code < 300;
    }

    /** Verifies server + token; returns the server's description of this reader. */
    public String ping() throws IOException {
        HttpURLConnection conn = open("/api/ingest/ping", "GET");
        int code = conn.getResponseCode();
        InputStream is = code < 400 ? conn.getInputStream() : conn.getErrorStream();
        StringBuilder sb = new StringBuilder();
        if (is != null) {
            BufferedReader reader = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8));
            try {
                String line;
                while ((line = reader.readLine()) != null && sb.length() < 4096) sb.append(line);
            } finally {
                reader.close();
            }
        }
        conn.disconnect();
        if (code != 200) throw new IOException("HTTP " + code + ": " + sb);
        return sb.toString();
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
