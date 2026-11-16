package com.seekstars.muselauncher;

import org.junit.Test;
import java.util.*;
import static org.junit.Assert.*;

public class PageToolsRepositoryTest {
    static final class MemoryStore implements KeyValueStore {
        final Map<String, Object> values = new HashMap<>();
        public String getString(String key, String fallback) { return (String) values.getOrDefault(key, fallback); }
        public long getLong(String key, long fallback) { return (Long) values.getOrDefault(key, fallback); }
        public boolean getBoolean(String key, boolean fallback) { return (Boolean) values.getOrDefault(key, fallback); }
        public void putAll(Map<String, Object> data) { values.putAll(data); }
        public void putString(String key, String value) { values.put(key, value); }
        public void putLong(String key, long value) { values.put(key, value); }
        public void putBoolean(String key, boolean value) { values.put(key, value); }
    }
    @Test public void recordsRoundTripWithoutCredentialsAndKeepAccount() {
        DownloadRepository.Record record = new DownloadRepository.Record(42, 7, "图像.png", "https://cdn.example/a?token=secret", 1234);
        List<DownloadRepository.Record> decoded = DownloadRepository.decode(DownloadRepository.encode(Collections.singletonList(record)));
        assertEquals(1, decoded.size());
        assertEquals(42, decoded.get(0).id);
        assertEquals(7, decoded.get(0).accountId);
        assertEquals("图像.png", decoded.get(0).filename);
        assertEquals("https://cdn.example/a", decoded.get(0).sourceUrl);
        assertEquals(1234, decoded.get(0).createdAt);
    }
    @Test public void malformedAndDuplicateRecordsDoNotExpandQueryScope() {
        assertTrue(DownloadRepository.decode("broken").isEmpty());
        String data = "[{\"id\":9,\"accountId\":2,\"filename\":\"ok\",\"url\":\"https://a.test/f\",\"createdAt\":1},"
                + "{\"id\":9,\"accountId\":2,\"filename\":\"duplicate\",\"url\":\"https://a.test/f\",\"createdAt\":1},"
                + "{\"id\":-1},{\"id\":0},{\"id\":10,\"url\":\"file:///etc/hosts\"}]";
        List<DownloadRepository.Record> records = DownloadRepository.decode(data);
        assertEquals(1, records.size());
        assertEquals(9, records.get(0).id);
    }
    @Test public void removeRecordOnlyChangesAppHistory() {
        MemoryStore store = new MemoryStore();
        DownloadRepository repository = new DownloadRepository(store);
        repository.add(new DownloadRepository.Record(42, 7, "a.png", "https://a.test/a", 1));
        repository.add(new DownloadRepository.Record(43, 8, "b.png", "https://a.test/b", 2));
        assertTrue(repository.contains(42));
        repository.removeRecord(42);
        DownloadRepository loaded = new DownloadRepository(store);
        assertFalse(loaded.contains(42));
        assertTrue(loaded.contains(43));
        assertEquals(1, loaded.records().size());
    }
    @Test public void settingsDefaultDisabledAndPublishIndependentSnapshot() {
        MemoryStore store = new MemoryStore();
        BlockingSettings settings = new BlockingSettings(store);
        assertFalse(settings.isEnabled());
        settings.save(true, "ads.example.com", "");
        DomainRules previous = settings.snapshot();
        settings.save(true, "", "ads.example.com");
        assertTrue(previous.shouldBlock("https://ads.example.com", false));
        assertFalse(settings.snapshot().shouldBlock("https://ads.example.com", false));
        assertFalse(new BlockingSettings(store).snapshot().shouldBlock("https://ads.example.com", false));
    }
    @Test public void invalidSettingsNeverReplacePreviousSnapshot() {
        BlockingSettings settings = new BlockingSettings(new MemoryStore());
        settings.save(true, "ads.example.com", "");
        assertThrows(IllegalArgumentException.class, () -> settings.save(true, "bad/url", ""));
        assertTrue(settings.snapshot().shouldBlock("https://ads.example.com", false));
    }
}
