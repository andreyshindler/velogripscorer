package com.velogrip.rfid;

/** A single tag observation from the reader. */
public final class TagRead {
    public final String epc;      // uppercase hex
    public final Double rssi;     // dBm, nullable
    public final long readAtMs;   // epoch millis (device clock)
    public final Integer antenna; // reader antenna/port that saw the tag, nullable

    public TagRead(String epc, Double rssi, long readAtMs) {
        this(epc, rssi, readAtMs, null);
    }

    public TagRead(String epc, Double rssi, long readAtMs, Integer antenna) {
        this.epc = epc;
        this.rssi = rssi;
        this.readAtMs = readAtMs;
        this.antenna = antenna;
    }
}
