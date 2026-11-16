package com.seekstars.muselauncher;

import android.app.DownloadManager;
import android.content.Context;
import android.database.Cursor;
import org.json.JSONArray;
import org.json.JSONObject;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/** App-owned IDs only. Removing a record is deliberately independent of DownloadManager.remove. */
public final class DownloadRepository {
    private static final String KEY = "records_v1";
    private final KeyValueStore store;

    public static final class Record {
        public final long id, accountId, createdAt;
        public final String filename, sourceUrl;
        public Record(long id, long accountId, String filename, String sourceUrl, long createdAt) {
            if (id <= 0 || accountId <= 0 || createdAt < 0) throw new IllegalArgumentException("Invalid download record");
            this.id = id;
            this.accountId = accountId;
            this.filename = DownloadPolicy.sanitizeFilename(filename);
            this.sourceUrl = DownloadPolicy.historyUrl(sourceUrl);
            this.createdAt = createdAt;
        }
    }

    public static final class Entry {
        public final Record record;
        /** 0 means the system no longer has this task. */
        public final int status, reason;
        public final long downloaded, total;
        Entry(Record record, int status, int reason, long downloaded, long total) {
            this.record = record; this.status = status; this.reason = reason;
            this.downloaded = downloaded; this.total = total;
        }
        public boolean isActive() {
            return status == DownloadManager.STATUS_PENDING || status == DownloadManager.STATUS_RUNNING
                    || status == DownloadManager.STATUS_PAUSED;
        }
    }

    public DownloadRepository(Context context) {
        this(new SharedPreferencesStore(context.getApplicationContext(), "page_tools_downloads"));
    }
    public DownloadRepository(KeyValueStore store) { this.store = store; }

    public static String encode(List<Record> records) {
        JSONArray array = new JSONArray();
        try {
            for (Record r : records) {
                JSONObject o = new JSONObject();
                o.put("id", r.id); o.put("accountId", r.accountId); o.put("filename", r.filename);
                o.put("url", r.sourceUrl); o.put("createdAt", r.createdAt);
                array.put(o);
            }
        } catch (Exception e) { throw new IllegalArgumentException("Invalid download records", e); }
        return array.toString();
    }

    public static List<Record> decode(String text) {
        List<Record> result = new ArrayList<>();
        Set<Long> seen = new HashSet<>();
        try {
            JSONArray array = new JSONArray(text);
            for (int i = 0; i < array.length(); i++) {
                try {
                    JSONObject o = array.getJSONObject(i);
                    Record r = new Record(o.getLong("id"), o.getLong("accountId"), o.getString("filename"),
                            o.getString("url"), o.getLong("createdAt"));
                    if (seen.add(r.id)) result.add(r);
                } catch (Exception ignored) { /* One corrupt row must not hide valid rows. */ }
            }
        } catch (Exception ignored) { }
        return result;
    }

    public List<Record> records() { return Collections.unmodifiableList(decode(store.getString(KEY, "[]"))); }
    public boolean contains(long id) {
        for (Record record : records()) if (record.id == id) return true;
        return false;
    }
    public void add(Record record) {
        List<Record> records = new ArrayList<>(records());
        records.removeIf(r -> r.id == record.id);
        records.add(0, record);
        store.putString(KEY, encode(records));
    }
    public void removeRecord(long id) {
        List<Record> records = new ArrayList<>(records());
        records.removeIf(r -> r.id == id);
        store.putString(KEY, encode(records));
    }

    /** Query only known IDs, never all system downloads. Cursor closes even on parsing failure. */
    public List<Entry> query(DownloadManager manager) {
        List<Record> records = records();
        if (records.isEmpty()) return Collections.emptyList();
        long[] ids = new long[records.size()];
        for (int i = 0; i < ids.length; i++) ids[i] = records.get(i).id;
        Map<Long, Entry> found = new HashMap<>();
        Map<Long, Record> known = new HashMap<>();
        for (Record r : records) known.put(r.id, r);
        try (Cursor cursor = manager.query(new DownloadManager.Query().setFilterById(ids))) {
            if (cursor != null) {
                int idColumn = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_ID);
                int statusColumn = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS);
                int reasonColumn = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON);
                int bytesColumn = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR);
                int totalColumn = cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES);
                while (cursor.moveToNext()) {
                    long id = cursor.getLong(idColumn);
                    Record record = known.get(id);
                    if (record != null) found.put(id, new Entry(record, cursor.getInt(statusColumn),
                            cursor.getInt(reasonColumn), cursor.getLong(bytesColumn), cursor.getLong(totalColumn)));
                }
            }
        }
        List<Entry> result = new ArrayList<>();
        for (Record r : records) result.add(found.containsKey(r.id) ? found.get(r.id) : new Entry(r, 0, 0, 0, -1));
        return result;
    }

    /** Explicit cancel deletes the system task and its partial file; app history remains. */
    public boolean cancel(DownloadManager manager, long id) {
        if (!contains(id)) return false;
        for (Entry e : query(manager)) {
            if (e.record.id == id && e.isActive()) return manager.remove(id) > 0;
        }
        return false;
    }
}
