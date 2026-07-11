package com.velogrip.rfid;

/** A single tag observation from the reader. */
public final class TagRead {
    public final String epc;      // uppercase hex
    public final Double rssi;     // dBm, nullable
    public final long readAtMs;   // epoch millis (device clock)

    public TagRead(String epc, Double rssi, long readAtMs) {
        this.epc = epc;
        this.rssi = rssi;
        this.readAtMs = readAtMs;
    }
}
