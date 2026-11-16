package com.seekstars.muselauncher;

import org.junit.Test;
import static org.junit.Assert.*;

public class PageToolsDownloadPolicyTest {
    @Test public void acceptsOnlyAbsoluteHttpUrlsAndDropsFragments() {
        assertEquals("https://example.com/a?q=1", DownloadPolicy.normalizeUrl("HTTPS://EXAMPLE.COM/a?q=1#secret"));
        assertEquals("http://127.0.0.1:8080/a", DownloadPolicy.normalizeUrl("http://127.0.0.1:8080/a"));
        for (String bad : new String[]{null, "", "blob:https://example.com/id", "data:image/png,a", "file:///tmp/a", "javascript:alert(1)", "//example.com/a", "https:///a", "https://user:password@example.com/a", "https://example.com:99999/a", "https://example.com/a\r\nCookie:x", "https://example.com/%0d%0aHeader:x", "https://good.example\\@evil.example/a"}) {
            assertThrows(String.valueOf(bad), IllegalArgumentException.class, () -> DownloadPolicy.normalizeUrl(bad));
        }
    }
    @Test public void filenamesRemoveTraversalControlsAndReservedCharacters() {
        assertEquals("secret_.png", DownloadPolicy.sanitizeFilename("../../secret?.png"));
        assertEquals("photo.png", DownloadPolicy.sanitizeFilename("C:\\tmp\\photo.png"));
        assertEquals("download", DownloadPolicy.sanitizeFilename(".."));
        assertEquals("download", DownloadPolicy.sanitizeFilename(" \n\r "));
        assertEquals("report_pdf", DownloadPolicy.sanitizeFilename("report\u202Epdf"));
        String longName = DownloadPolicy.sanitizeFilename(new String(new char[400]).replace('\0', 'a') + ".png");
        assertTrue(longName.length() <= 120);
        assertTrue(longName.endsWith(".png"));
    }
    @Test public void unicodeFilenameFitsFilesystemByteLimit() {
        String filename = DownloadPolicy.sanitizeFilename(new String(new char[120]).replace('\0', '图') + ".png");
        assertTrue(filename.getBytes(java.nio.charset.StandardCharsets.UTF_8).length <= 240);
        assertTrue(filename.endsWith(".png"));
    }
    @Test public void unsafeHeadersAreOmittedRatherThanInjected() {
        assertEquals("a=1; b=2", DownloadPolicy.headerValue("a=1; b=2"));
        assertNull(DownloadPolicy.headerValue("a=1\r\nHost: evil.test"));
        assertNull(DownloadPolicy.headerValue("\n"));
    }
    @Test public void systemDownloadsForwardOnlyUserAgentNeverSessionHeaders() {
        java.util.Map<String, String> candidates = new java.util.LinkedHashMap<>();
        candidates.put("user-agent", "Muse-Test-UA");
        candidates.put("Cookie", "session=private");
        candidates.put("Authorization", "Bearer private");
        candidates.put("Proxy-Authorization", "Basic private");
        candidates.put("Referer", "https://private.example/page?token=private");
        candidates.put("X-Api-Key", "private");
        assertEquals(java.util.Collections.singletonMap("User-Agent", "Muse-Test-UA"),
                DownloadPolicy.forwardedHeaders(candidates));
    }
    @Test public void systemDownloadsOmitUnsafeUserAgentAndAllOtherHeaders() {
        java.util.Map<String, String> candidates = new java.util.LinkedHashMap<>();
        candidates.put("USER-AGENT", "ua\r\nCookie: private");
        candidates.put("cookie", "session=private");
        assertTrue(DownloadPolicy.forwardedHeaders(candidates).isEmpty());
        assertTrue(DownloadPolicy.forwardedHeaders(null).isEmpty());
    }
    @Test public void forwardedHeaderSnapshotIsImmutableAndIndependent() {
        java.util.Map<String, String> candidates = new java.util.HashMap<>();
        candidates.put("User-Agent", "initial");
        java.util.Map<String, String> snapshot = DownloadPolicy.forwardedHeaders(candidates);
        candidates.put("User-Agent", "changed");
        assertEquals("initial", snapshot.get("User-Agent"));
        assertThrows(UnsupportedOperationException.class, () -> snapshot.put("Cookie", "private"));
    }
    @Test public void cookieLookupUsesTargetUrlNotTopPage() {
        assertEquals("https://cdn.example.com/photo.png?token=1", DownloadPolicy.cookieUrl("https://CDN.EXAMPLE.COM/photo.png?token=1#part"));
    }
    @Test public void recordUrlOmitsQuerySecrets() {
        assertEquals("https://example.com/image", DownloadPolicy.historyUrl("https://example.com/image?token=secret#part"));
    }
}
