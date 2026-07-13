package com.velogrip.rfid;

import com.velogrip.rfid.protocol.LlrpEngine;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.util.List;

/**
 * A short-lived reader session for the Program RFID Chips screen: connects to
 * the reader, reads the EPC of the tag in front of the antenna, and issues an
 * LLRP AccessSpec that writes a new EPC. Kept separate from the background
 * bridge so programming never fights the race's continuous inventory.
 *
 * Only the LLRP path can program chips; the write is verified by reading the
 * chip again (matching the reference app). Demo mode fakes a chip so the UI
 * can be exercised without hardware.
 */
public final class ChipProgrammer {

    public interface Listener {
        void onStatus(String message, boolean connected);
    }

    private final String host;
    private final int port;
    private final String protocol;
    private final Listener listener;

    private Socket socket;
    private InputStream in;
    private OutputStream out;
    private LlrpEngine engine;
    private volatile boolean connected;

    public ChipProgrammer(Prefs prefs, Listener listener) {
        this.host = prefs.readerHost();
        this.port = prefs.readerPort();
        this.protocol = prefs.protocol();
        this.listener = listener;
    }

    public boolean isDemo() { return Prefs.PROTOCOL_DEMO.equals(protocol); }

    /** Blocking connect — call off the UI thread. */
    public void connect() {
        if (isDemo()) { connected = true; listener.onStatus("Demo reader", true); return; }
        if (host.isEmpty()) { listener.onStatus("No reader IP set", false); return; }
        try {
            socket = new Socket();
            socket.connect(new InetSocketAddress(host, port), 5000);
            socket.setSoTimeout(1500);
            in = socket.getInputStream();
            out = socket.getOutputStream();
            if (Prefs.PROTOCOL_LLRP.equals(protocol)) {
                engine = new LlrpEngine();
                out.write(engine.onConnect());
                out.flush();
            }
            connected = true;
            listener.onStatus(host + ":" + port, true);
        } catch (Exception e) {
            connected = false;
            listener.onStatus("Not connected: " + e.getMessage(), false);
        }
    }

    /** Reads the next EPC seen, up to timeoutMs. Returns null on timeout. */
    public String readEpc(int timeoutMs) {
        if (isDemo()) {
            try { Thread.sleep(500); } catch (InterruptedException ignored) { }
            return "E2801170000002" + String.format("%010X", (System.nanoTime() & 0xFFFFFFFFL));
        }
        if (!connected || engine == null) return null;
        long deadline = System.currentTimeMillis() + timeoutMs;
        byte[] buffer = new byte[8192];
        while (System.currentTimeMillis() < deadline) {
            try {
                byte[] pending = engine.takeOutbound();
                if (pending.length > 0) { out.write(pending); out.flush(); }
                int n = in.read(buffer);
                if (n < 0) break;
                if (n > 0) {
                    List<TagRead> reads = engine.feed(buffer, n);
                    if (!reads.isEmpty()) return reads.get(0).epc;
                }
            } catch (java.net.SocketTimeoutException te) {
                // keep waiting until the deadline
            } catch (Exception e) {
                return null;
            }
        }
        return null;
    }

    /** Issues the write AccessSpec. Verification is a subsequent readEpc(). */
    public boolean writeEpc(String newEpc) {
        if (isDemo()) return true;
        if (!connected || engine == null) return false;
        try {
            out.write(engine.programEpc(newEpc));
            out.flush();
            return true;
        } catch (Exception e) {
            return false;
        }
    }

    public void close() {
        connected = false;
        try { if (socket != null) socket.close(); } catch (Exception ignored) { }
    }
}
