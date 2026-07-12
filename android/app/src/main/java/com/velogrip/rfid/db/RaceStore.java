package com.velogrip.rfid.db;

import android.content.ContentValues;
import android.content.Context;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;

import com.velogrip.rfid.TagRead;

import java.util.ArrayList;
import java.util.List;

/**
 * The phone's own race database — the app is a standalone timing computer and
 * this store is its source of truth. Nothing here requires the web platform:
 *
 *   racers    start list (EPC -> bib/name/category/wave), typed in or synced
 *   waves     gun times recorded locally when the organizer taps Start
 *   passings  every tag read, kept forever; `uploaded` tracks web sync
 *
 * The uploader marks rows as uploaded instead of deleting them, so live local
 * results keep working with or without connectivity.
 */
public final class RaceStore extends SQLiteOpenHelper {

    public static final class Racer {
        public final String epc, bib, name, category, wave, distance;

        public Racer(String epc, String bib, String name, String category, String wave) {
            this(epc, bib, name, category, wave, "");
        }

        public Racer(String epc, String bib, String name, String category, String wave, String distance) {
            this.epc = epc; this.bib = bib; this.name = name; this.category = category; this.wave = wave;
            this.distance = distance;
        }
    }

    public static final class Wave {
        public final String name;
        public final Long startedAtMs;   // null until started
        public final boolean synced;

        public Wave(String name, Long startedAtMs, boolean synced) {
            this.name = name; this.startedAtMs = startedAtMs; this.synced = synced;
        }
    }

    public static final class Passing {
        public final long id;
        public final String epc;
        public final Double rssi;
        public final long readAtMs;

        public Passing(long id, String epc, Double rssi, long readAtMs) {
            this.id = id; this.epc = epc; this.rssi = rssi; this.readAtMs = readAtMs;
        }
    }

    public RaceStore(Context ctx) {
        super(ctx, "race.db", null, 3);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE racers (epc TEXT PRIMARY KEY, bib TEXT NOT NULL DEFAULT ''," +
                " name TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT ''," +
                " wave TEXT NOT NULL DEFAULT '', distance TEXT NOT NULL DEFAULT '')");
        db.execSQL("CREATE TABLE waves (name TEXT PRIMARY KEY, started_at INTEGER, synced INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE passings (id INTEGER PRIMARY KEY AUTOINCREMENT, epc TEXT NOT NULL," +
                " rssi REAL, read_at INTEGER NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE distances (name TEXT PRIMARY KEY, laps INTEGER NOT NULL DEFAULT 1)");
        db.execSQL("CREATE INDEX idx_passings_epc ON passings(epc, read_at)");
        db.execSQL("CREATE INDEX idx_passings_uploaded ON passings(uploaded, id)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        if (oldVersion < 2) {
            db.execSQL("ALTER TABLE racers ADD COLUMN distance TEXT NOT NULL DEFAULT ''");
        }
        if (oldVersion < 3) {
            db.execSQL("CREATE TABLE distances (name TEXT PRIMARY KEY, laps INTEGER NOT NULL DEFAULT 1)");
        }
    }

    // ---- passings ----

    public void addPassing(TagRead read) {
        ContentValues values = new ContentValues();
        values.put("epc", read.epc);
        if (read.rssi != null) values.put("rssi", read.rssi);
        values.put("read_at", read.readAtMs);
        getWritableDatabase().insert("passings", null, values);
    }

    public List<Passing> pendingUpload(int limit) {
        List<Passing> out = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT id, epc, rssi, read_at FROM passings WHERE uploaded = 0 ORDER BY id LIMIT ?",
                new String[]{String.valueOf(limit)});
        try {
            while (c.moveToNext()) {
                out.add(new Passing(c.getLong(0), c.getString(1),
                        c.isNull(2) ? null : c.getDouble(2), c.getLong(3)));
            }
        } finally {
            c.close();
        }
        return out;
    }

    public void markUploaded(long maxIdInclusive) {
        getWritableDatabase().execSQL("UPDATE passings SET uploaded = 1 WHERE id <= ? AND uploaded = 0",
                new Object[]{maxIdInclusive});
    }

    public long pendingCount() {
        return count("SELECT COUNT(*) FROM passings WHERE uploaded = 0");
    }

    public long passingCount() {
        return count("SELECT COUNT(*) FROM passings");
    }

    /** Wipes the stored race (start list, waves, passings) before pairing a new one. */
    public void clearRace() {
        SQLiteDatabase db = getWritableDatabase();
        db.execSQL("DELETE FROM passings");
        db.execSQL("DELETE FROM waves");
        db.execSQL("DELETE FROM racers");
        db.execSQL("DELETE FROM distances");
    }

    // ---- lap targets per distance ("" = whole race when no distances) ----

    public int lapsFor(String distance) {
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT laps FROM distances WHERE name = ?", new String[]{distance});
        try {
            return c.moveToNext() ? Math.max(1, c.getInt(0)) : 1;
        } finally {
            c.close();
        }
    }

    public java.util.Map<String, Integer> lapTargets() {
        java.util.Map<String, Integer> out = new java.util.HashMap<>();
        Cursor c = getReadableDatabase().rawQuery("SELECT name, laps FROM distances", null);
        try {
            while (c.moveToNext()) out.put(c.getString(0), Math.max(1, c.getInt(1)));
        } finally {
            c.close();
        }
        return out;
    }

    public void setLaps(String distance, int laps) {
        ContentValues values = new ContentValues();
        values.put("name", distance);
        values.put("laps", Math.max(1, laps));
        getWritableDatabase().insertWithOnConflict("distances", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public List<Passing> allPassings() {
        List<Passing> out = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT id, epc, rssi, read_at FROM passings ORDER BY read_at", null);
        try {
            while (c.moveToNext()) {
                out.add(new Passing(c.getLong(0), c.getString(1),
                        c.isNull(2) ? null : c.getDouble(2), c.getLong(3)));
            }
        } finally {
            c.close();
        }
        return out;
    }

    // ---- racers (start list) ----

    public void upsertRacer(Racer racer) {
        ContentValues values = new ContentValues();
        values.put("epc", racer.epc);
        values.put("bib", racer.bib);
        values.put("name", racer.name);
        values.put("category", racer.category);
        values.put("wave", racer.wave);
        values.put("distance", racer.distance);
        getWritableDatabase().insertWithOnConflict("racers", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public List<Racer> racers() {
        List<Racer> out = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT epc, bib, name, category, wave, distance FROM racers ORDER BY bib, epc", null);
        try {
            while (c.moveToNext()) {
                out.add(new Racer(c.getString(0), c.getString(1), c.getString(2), c.getString(3),
                        c.getString(4), c.getString(5)));
            }
        } finally {
            c.close();
        }
        return out;
    }

    public Racer racerByBib(String bib) {
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT epc, bib, name, category, wave, distance FROM racers WHERE bib = ? LIMIT 1", new String[]{bib});
        try {
            return c.moveToNext()
                    ? new Racer(c.getString(0), c.getString(1), c.getString(2), c.getString(3),
                            c.getString(4), c.getString(5))
                    : null;
        } finally {
            c.close();
        }
    }

    // ---- waves ----

    public void upsertWave(String name, Long startedAtMs, boolean synced) {
        ContentValues values = new ContentValues();
        values.put("name", name);
        if (startedAtMs != null) values.put("started_at", startedAtMs);
        values.put("synced", synced ? 1 : 0);
        getWritableDatabase().insertWithOnConflict("waves", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    /** Records the gun time locally; returns false if already started (no force). */
    public boolean startWave(String name, long atMs, boolean force) {
        Wave existing = wave(name);
        if (existing != null && existing.startedAtMs != null && !force) return false;
        ContentValues values = new ContentValues();
        values.put("name", name);
        values.put("started_at", atMs);
        values.put("synced", 0);
        getWritableDatabase().insertWithOnConflict("waves", null, values, SQLiteDatabase.CONFLICT_REPLACE);
        return true;
    }

    public Wave wave(String name) {
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT name, started_at, synced FROM waves WHERE name = ?", new String[]{name});
        try {
            return c.moveToNext()
                    ? new Wave(c.getString(0), c.isNull(1) ? null : c.getLong(1), c.getInt(2) == 1)
                    : null;
        } finally {
            c.close();
        }
    }

    public List<Wave> waves() {
        List<Wave> out = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT name, started_at, synced FROM waves ORDER BY name", null);
        try {
            while (c.moveToNext()) {
                out.add(new Wave(c.getString(0), c.isNull(1) ? null : c.getLong(1), c.getInt(2) == 1));
            }
        } finally {
            c.close();
        }
        return out;
    }

    public List<Wave> unsyncedStartedWaves() {
        List<Wave> out = new ArrayList<>();
        for (Wave w : waves()) if (w.startedAtMs != null && !w.synced) out.add(w);
        return out;
    }

    public void markWaveSynced(String name) {
        getWritableDatabase().execSQL("UPDATE waves SET synced = 1 WHERE name = ?", new Object[]{name});
    }

    private long count(String sql) {
        Cursor c = getReadableDatabase().rawQuery(sql, null);
        try {
            return c.moveToFirst() ? c.getLong(0) : 0;
        } finally {
            c.close();
        }
    }
}
