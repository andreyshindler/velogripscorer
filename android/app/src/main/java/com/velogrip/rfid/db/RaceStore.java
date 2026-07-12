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
        public final String epc, bib, name, category, wave, distance, status, gender;

        public Racer(String epc, String bib, String name, String category, String wave) {
            this(epc, bib, name, category, wave, "", "", "");
        }

        public Racer(String epc, String bib, String name, String category, String wave, String distance) {
            this(epc, bib, name, category, wave, distance, "", "");
        }

        public Racer(String epc, String bib, String name, String category, String wave,
                     String distance, String status) {
            this(epc, bib, name, category, wave, distance, status, "");
        }

        public Racer(String epc, String bib, String name, String category, String wave,
                     String distance, String status, String gender) {
            this.epc = epc; this.bib = bib; this.name = name; this.category = category; this.wave = wave;
            this.distance = distance; this.status = status; this.gender = gender;
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
        public final Integer antenna;
        public final long readAtMs;

        public Passing(long id, String epc, Double rssi, long readAtMs) {
            this(id, epc, rssi, null, readAtMs);
        }

        public Passing(long id, String epc, Double rssi, Integer antenna, long readAtMs) {
            this.id = id; this.epc = epc; this.rssi = rssi; this.antenna = antenna; this.readAtMs = readAtMs;
        }
    }

    public RaceStore(Context ctx) {
        super(ctx, "race.db", null, 7);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE racers (epc TEXT PRIMARY KEY, bib TEXT NOT NULL DEFAULT ''," +
                " name TEXT NOT NULL DEFAULT '', category TEXT NOT NULL DEFAULT ''," +
                " wave TEXT NOT NULL DEFAULT '', distance TEXT NOT NULL DEFAULT ''," +
                " racer_status TEXT NOT NULL DEFAULT '', gender TEXT NOT NULL DEFAULT '')");
        db.execSQL("CREATE TABLE waves (name TEXT PRIMARY KEY, started_at INTEGER, synced INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE passings (id INTEGER PRIMARY KEY AUTOINCREMENT, epc TEXT NOT NULL," +
                " rssi REAL, antenna INTEGER, read_at INTEGER NOT NULL, uploaded INTEGER NOT NULL DEFAULT 0)");
        db.execSQL("CREATE TABLE distances (name TEXT PRIMARY KEY, laps INTEGER NOT NULL DEFAULT 1)");
        db.execSQL("CREATE TABLE categories (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)");
        db.execSQL("CREATE TABLE pending (id INTEGER PRIMARY KEY AUTOINCREMENT, epc TEXT NOT NULL DEFAULT ''," +
                " bib TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', read_at INTEGER NOT NULL DEFAULT 0)");
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
        if (oldVersion < 4) {
            db.execSQL("CREATE TABLE categories (name TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 1)");
        }
        if (oldVersion < 5) {
            db.execSQL("ALTER TABLE racers ADD COLUMN racer_status TEXT NOT NULL DEFAULT ''");
        }
        if (oldVersion < 6) {
            db.execSQL("CREATE TABLE pending (id INTEGER PRIMARY KEY AUTOINCREMENT, epc TEXT NOT NULL DEFAULT ''," +
                    " bib TEXT NOT NULL DEFAULT '', name TEXT NOT NULL DEFAULT '', read_at INTEGER NOT NULL DEFAULT 0)");
        }
        if (oldVersion < 7) {
            db.execSQL("ALTER TABLE passings ADD COLUMN antenna INTEGER");
            db.execSQL("ALTER TABLE racers ADD COLUMN gender TEXT NOT NULL DEFAULT ''");
        }
    }

    // ---- passings ----

    public void addPassing(TagRead read) {
        ContentValues values = new ContentValues();
        values.put("epc", read.epc);
        if (read.rssi != null) values.put("rssi", read.rssi);
        if (read.antenna != null) values.put("antenna", read.antenna);
        values.put("read_at", read.readAtMs);
        getWritableDatabase().insert("passings", null, values);
    }

    public List<Passing> pendingUpload(int limit) {
        List<Passing> out = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT id, epc, rssi, antenna, read_at FROM passings WHERE uploaded = 0 ORDER BY id LIMIT ?",
                new String[]{String.valueOf(limit)});
        try {
            while (c.moveToNext()) {
                out.add(new Passing(c.getLong(0), c.getString(1),
                        c.isNull(2) ? null : c.getDouble(2),
                        c.isNull(3) ? null : c.getInt(3), c.getLong(4)));
            }
        } finally {
            c.close();
        }
        return out;
    }

    /** Records a finish for a specific chip at a given time (grid tap / No Bib). */
    public void recordPassing(String epc, long atMs) {
        ContentValues values = new ContentValues();
        values.put("epc", epc);
        values.put("read_at", atMs);
        getWritableDatabase().insert("passings", null, values);
    }

    public List<Passing> passingsForEpc(String epc) {
        List<Passing> out = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT id, epc, rssi, read_at FROM passings WHERE epc = ? ORDER BY read_at", new String[]{epc});
        try {
            while (c.moveToNext()) {
                out.add(new Passing(c.getLong(0), c.getString(1), c.isNull(2) ? null : c.getDouble(2), c.getLong(3)));
            }
        } finally {
            c.close();
        }
        return out;
    }

    public void deletePassing(long id) {
        getWritableDatabase().execSQL("DELETE FROM passings WHERE id = ?", new Object[]{id});
    }

    /** Clears every recorded passing (Restart race -> Discard). */
    public void clearPassings() {
        getWritableDatabase().execSQL("DELETE FROM passings");
    }

    /** Un-starts every wave so the race can be re-gunned from Race Start. */
    public void clearGunTimes() {
        getWritableDatabase().execSQL("UPDATE waves SET started_at = NULL, synced = 0");
    }

    public void clearPending() {
        getWritableDatabase().execSQL("DELETE FROM pending");
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
        db.execSQL("DELETE FROM categories");
        db.execSQL("DELETE FROM pending");
    }

    // ---- pending timing entries (pre-entered bib awaiting a time, or a time
    // awaiting a bib) for the Race Timing tap flow ----

    public static final class Pending {
        public final long id;
        public final String epc, bib, name;
        public final long readAtMs;   // 0 = no time yet (racer waiting for a time)
        public Pending(long id, String epc, String bib, String name, long readAtMs) {
            this.id = id; this.epc = epc; this.bib = bib; this.name = name; this.readAtMs = readAtMs;
        }
        public boolean hasTime() { return readAtMs > 0; }
        public boolean hasRacer() { return !epc.isEmpty(); }
    }

    /** Timer pressed with no racer selected: a time waiting for a bib. */
    public void addPendingTime(long readAtMs) {
        ContentValues v = new ContentValues();
        v.put("read_at", readAtMs);
        getWritableDatabase().insert("pending", null, v);
    }

    /** Racer tapped with no time waiting: a bib waiting for a time. */
    public void addPendingRacer(String epc, String bib, String name) {
        ContentValues v = new ContentValues();
        v.put("epc", epc); v.put("bib", bib); v.put("name", name); v.put("read_at", 0);
        getWritableDatabase().insert("pending", null, v);
    }

    public List<Pending> pendingEntries() {
        List<Pending> out = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT id, epc, bib, name, read_at FROM pending ORDER BY id", null);
        try {
            while (c.moveToNext()) {
                out.add(new Pending(c.getLong(0), c.getString(1), c.getString(2), c.getString(3), c.getLong(4)));
            }
        } finally {
            c.close();
        }
        return out;
    }

    public void deletePending(long id) {
        getWritableDatabase().execSQL("DELETE FROM pending WHERE id = ?", new Object[]{id});
    }

    // ---- categories (curated set for category results) ----

    public static final class Category {
        public final String name;
        public final boolean enabled;
        public Category(String name, boolean enabled) { this.name = name; this.enabled = enabled; }
    }

    /** Seeds the category table from the start list the first time it is empty. */
    public void seedCategoriesFromStartList() {
        if (count("SELECT COUNT(*) FROM categories") > 0) return;
        SQLiteDatabase db = getWritableDatabase();
        Cursor c = db.rawQuery("SELECT DISTINCT category FROM racers WHERE category != '' ORDER BY category", null);
        try {
            while (c.moveToNext()) {
                ContentValues v = new ContentValues();
                v.put("name", c.getString(0));
                v.put("enabled", 1);
                db.insertWithOnConflict("categories", null, v, SQLiteDatabase.CONFLICT_IGNORE);
            }
        } finally {
            c.close();
        }
    }

    public List<Category> categories() {
        List<Category> out = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery("SELECT name, enabled FROM categories ORDER BY name", null);
        try {
            while (c.moveToNext()) out.add(new Category(c.getString(0), c.getInt(1) == 1));
        } finally {
            c.close();
        }
        return out;
    }

    public void addCategory(String name) {
        ContentValues v = new ContentValues();
        v.put("name", name.trim());
        v.put("enabled", 1);
        getWritableDatabase().insertWithOnConflict("categories", null, v, SQLiteDatabase.CONFLICT_IGNORE);
    }

    public void setCategoryEnabled(String name, boolean enabled) {
        getWritableDatabase().execSQL("UPDATE categories SET enabled = ? WHERE name = ?",
                new Object[]{enabled ? 1 : 0, name});
    }

    public void deleteCategory(String name) {
        getWritableDatabase().execSQL("DELETE FROM categories WHERE name = ?", new Object[]{name});
    }

    // ---- start-list roster (one entry per racer, grouped by bib) ----

    /** Distinct racers for the Start List: two-chip racers appear once. */
    public List<Racer> startListEntries() {
        List<Racer> out = new ArrayList<>();
        java.util.LinkedHashSet<String> seen = new java.util.LinkedHashSet<>();
        for (Racer r : racers()) {
            String key = r.bib.isEmpty() ? "e:" + r.epc : "b:" + r.bib;
            if (seen.add(key)) out.add(r);
        }
        return out;
    }

    public int racerCount() {
        return startListEntries().size();
    }

    public void deleteRacerByBib(String bib) {
        if (bib.isEmpty()) return;
        getWritableDatabase().execSQL("DELETE FROM racers WHERE bib = ?", new Object[]{bib});
    }

    public void deleteRacerByEpc(String epc) {
        getWritableDatabase().execSQL("DELETE FROM racers WHERE epc = ?", new Object[]{epc});
    }

    /** DNS/DNF/DSQ or "" — applied to every chip of the bib. */
    public void setRacerStatus(String bib, String status) {
        if (bib.isEmpty()) return;
        getWritableDatabase().execSQL("UPDATE racers SET racer_status = ? WHERE bib = ?",
                new Object[]{status, bib});
    }

    public void editRacer(String bib, String name, String category, String wave) {
        if (bib.isEmpty()) return;
        getWritableDatabase().execSQL(
                "UPDATE racers SET name = ?, category = ?, wave = ? WHERE bib = ?",
                new Object[]{name, category, wave, bib});
    }

    public void setRacerDistance(String bib, String distance) {
        if (bib.isEmpty()) return;
        getWritableDatabase().execSQL("UPDATE racers SET distance = ? WHERE bib = ?",
                new Object[]{distance, bib});
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
        values.put("racer_status", racer.status);
        values.put("gender", racer.gender);
        getWritableDatabase().insertWithOnConflict("racers", null, values, SQLiteDatabase.CONFLICT_REPLACE);
    }

    public List<Racer> racers() {
        List<Racer> out = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT epc, bib, name, category, wave, distance, racer_status, gender FROM racers ORDER BY bib, epc", null);
        try {
            while (c.moveToNext()) {
                out.add(new Racer(c.getString(0), c.getString(1), c.getString(2), c.getString(3),
                        c.getString(4), c.getString(5), c.getString(6), c.getString(7)));
            }
        } finally {
            c.close();
        }
        return out;
    }

    public Racer racerByBib(String bib) {
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT epc, bib, name, category, wave, distance, racer_status, gender FROM racers WHERE bib = ? LIMIT 1", new String[]{bib});
        try {
            return c.moveToNext()
                    ? new Racer(c.getString(0), c.getString(1), c.getString(2), c.getString(3),
                            c.getString(4), c.getString(5), c.getString(6), c.getString(7))
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
