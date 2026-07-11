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
 * Durable outbox for tag reads: everything the reader reports is stored here
 * first, then deleted only after the server acknowledges the upload. Survives
 * app restarts and long stretches without connectivity out in the field.
 */
public final class ReadQueue extends SQLiteOpenHelper {

    public static final class Row {
        public final long id;
        public final String epc;
        public final Double rssi;
        public final long readAtMs;

        Row(long id, String epc, Double rssi, long readAtMs) {
            this.id = id;
            this.epc = epc;
            this.rssi = rssi;
            this.readAtMs = readAtMs;
        }
    }

    public ReadQueue(Context ctx) {
        super(ctx, "read_queue.db", null, 1);
    }

    @Override
    public void onCreate(SQLiteDatabase db) {
        db.execSQL("CREATE TABLE reads (" +
                "id INTEGER PRIMARY KEY AUTOINCREMENT," +
                "epc TEXT NOT NULL," +
                "rssi REAL," +
                "read_at INTEGER NOT NULL)");
    }

    @Override
    public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
        // v1: nothing to migrate yet
    }

    public void add(TagRead read) {
        ContentValues values = new ContentValues();
        values.put("epc", read.epc);
        if (read.rssi != null) values.put("rssi", read.rssi);
        values.put("read_at", read.readAtMs);
        getWritableDatabase().insert("reads", null, values);
    }

    public List<Row> peekBatch(int limit) {
        List<Row> out = new ArrayList<>();
        Cursor c = getReadableDatabase().rawQuery(
                "SELECT id, epc, rssi, read_at FROM reads ORDER BY id LIMIT ?",
                new String[]{String.valueOf(limit)});
        try {
            while (c.moveToNext()) {
                out.add(new Row(c.getLong(0), c.getString(1),
                        c.isNull(2) ? null : c.getDouble(2), c.getLong(3)));
            }
        } finally {
            c.close();
        }
        return out;
    }

    public void deleteUpTo(long maxIdInclusive) {
        getWritableDatabase().delete("reads", "id <= ?", new String[]{String.valueOf(maxIdInclusive)});
    }

    public long pendingCount() {
        Cursor c = getReadableDatabase().rawQuery("SELECT COUNT(*) FROM reads", null);
        try {
            return c.moveToFirst() ? c.getLong(0) : 0;
        } finally {
            c.close();
        }
    }
}
