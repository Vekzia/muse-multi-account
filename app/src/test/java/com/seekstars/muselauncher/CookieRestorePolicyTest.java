package com.seekstars.muselauncher;

import org.junit.Test;

import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.assertThrows;

public class CookieRestorePolicyTest {
    @Test
    public void acceptsTabSeparatorsEmptyAndQuotedValuesWithoutChangingAttributes() {
        assertEquals(Arrays.asList(
                "empty=; Domain=muse.ai; Path=/; Secure",
                "quoted=\"abc=def\"; Domain=muse.ai; Path=/; Secure"),
                CookieRestorePolicy.toSetCookieLines("\tempty=;\tquoted=\"abc=def\";"));
    }

    @Test
    public void dropsNonCookieOctetsAndBackslashNames() {
        assertEquals(Arrays.asList("ok=value; Domain=muse.ai; Path=/; Secure"),
                CookieRestorePolicy.toSetCookieLines(
                        "bad\\name=x; unicode=值; comma=a,b; slash=a\\b; quote=ab\"cd; ok=value"));
    }

    @Test
    public void rejectsCoercedSchemaAndForeignApplication() {
        for (String prefix : Arrays.asList("\"schema\":1.5,\"app\":\"muse-launcher\"",
                "\"schema\":\"1\",\"app\":\"muse-launcher\"",
                "\"schema\":1,\"app\":\"foreign\"")) {
            assertThrows(CookieRestorePolicy.InvalidBackup.class,
                    () -> CookieRestorePolicy.parseForImport("{" + prefix
                            + ",\"accounts\":[{\"id\":1,\"name\":\"one\"}]}"));
        }
    }

    @Test
    public void emptyResultsFinishImmediatelyWithoutCookieSuccess() {
        CookieRestorePolicy.Results results = new CookieRestorePolicy.Results(Arrays.asList());
        assertTrue(results.isComplete());
        assertEquals(0, results.restoredAccounts());
        assertEquals(0, results.acceptedCookies());
    }

    @Test
    public void rejectsControlCharactersAndOversizeHeaders() {
        assertTrue(CookieRestorePolicy.toSetCookieLines("ok=a\r\nInjected=1").isEmpty());
        assertTrue(CookieRestorePolicy.toSetCookieLines("ok=a\u007f").isEmpty());
        assertTrue(CookieRestorePolicy.toSetCookieLines("k=" + "x".repeat(8191)).isEmpty());
        assertEquals(1, CookieRestorePolicy.toSetCookieLines("k=" + "x".repeat(8190)).size());
    }

    @Test
    public void dropsAttributeLikeTokensAndInvalidCookieValues() {
        assertEquals(Arrays.asList("ok=v; Domain=muse.ai; Path=/; Secure"),
                CookieRestorePolicy.toSetCookieLines(
                        "Path=/admin; Domain=evil.test; Max-Age=1; bad=two words; ok=v"));
    }

    @Test
    public void rejectsDuplicateSourceIdsBeforeCodecCanReassignCookies() {
        String raw = "{\"app\":\"muse-launcher\",\"schema\":1,\"accounts\":["
                + "{\"id\":7,\"name\":\"first\",\"cookies\":\"hatch_sess=a\"},"
                + "{\"id\":7,\"name\":\"second\",\"cookies\":\"hatch_sess=b\"}]}";
        CookieRestorePolicy.InvalidBackup error = assertThrows(
                CookieRestorePolicy.InvalidBackup.class, () -> CookieRestorePolicy.parseForImport(raw));
        assertEquals(CookieRestorePolicy.InvalidBackup.Reason.DUPLICATE_IDS, error.reason);
    }

    @Test
    public void rejectsPartiallyDamagedOrBlankAccountsBeforeReplacing() {
        for (String accounts : Arrays.asList("[{}]", "[3]",
                "[{\"id\":1,\"name\":\"good\"},{}]",
                "[{\"id\":1,\"name\":\"  \"}]",
                "[{\"id\":1.5,\"name\":\"fractional\"}]",
                "[{\"id\":\"1\",\"name\":\"coerced\"}]")) {
            assertThrows(accounts, CookieRestorePolicy.InvalidBackup.class,
                    () -> CookieRestorePolicy.parseForImport(
                            "{\"app\":\"muse-launcher\",\"schema\":1,\"accounts\":" + accounts + "}"));
        }
    }

    @Test
    public void validEmptyBackupIsDistinctFromMalformedEntries() throws Exception {
        BackupCodec.Snapshot snapshot = CookieRestorePolicy.parseForImport(
                "{\"app\":\"muse-launcher\",\"schema\":1,\"accounts\":[]}");
        assertTrue(snapshot.accounts.isEmpty());
        assertTrue(snapshot.cookies.isEmpty());
    }

    @Test
    public void validSnapshotPreservesSourceMappingAndCookieData() throws Exception {
        BackupCodec.Snapshot snapshot = CookieRestorePolicy.parseForImport(
                "{\"app\":\"muse-launcher\",\"schema\":1,\"accounts\":["
                        + "{\"id\":7,\"name\":\"primary\",\"cookies\":\"hatch_sess=abc\"}]}"
        );
        assertEquals(7L, snapshot.accounts.get(0).id);
        assertEquals("primary", snapshot.accounts.get(0).name);
        assertEquals("hatch_sess=abc", snapshot.cookies.get(7L));
    }

    @Test
    public void callbackResultsWaitForEveryCookieAndDeduplicateRepeatedCallbacks() {
        CookieRestorePolicy.Results results = new CookieRestorePolicy.Results(Arrays.asList(11L, 11L, 22L));
        assertFalse(results.isComplete());
        results.record(0, true);
        results.record(0, false);
        results.record(2, false);
        assertFalse(results.isComplete());
        results.record(1, true);
        assertTrue(results.isComplete());
        assertEquals(1, results.restoredAccounts());
        assertEquals(2, results.acceptedCookies());
    }

    @Test
    public void allFalseCallbacksAndPartialAccountDoNotReportRestoredAccount() {
        CookieRestorePolicy.Results allFailed = new CookieRestorePolicy.Results(Arrays.asList(11L, 22L));
        allFailed.record(0, false);
        allFailed.record(1, false);
        assertTrue(allFailed.isComplete());
        assertEquals(0, allFailed.restoredAccounts());
        CookieRestorePolicy.Results partial = new CookieRestorePolicy.Results(Arrays.asList(11L, 11L));
        partial.record(0, true);
        partial.record(1, false);
        assertEquals(0, partial.restoredAccounts());
        assertEquals(1, partial.acceptedCookies());
    }

    @Test
    public void restoresSessionCookieWithHttpOnlyAndOtherCookiesWithoutIt() {
        List<String> lines = CookieRestorePolicy.toSetCookieLines(
                "hatch_sess=abc; theme=dark");

        assertEquals(Arrays.asList(
                "hatch_sess=abc; Domain=muse.ai; Path=/; Secure; HttpOnly",
                "theme=dark; Domain=muse.ai; Path=/; Secure"), lines);
    }

    @Test
    public void rejectsInvalidNamesAndPrefixThatCannotUseRootDomain() {
        List<String> lines = CookieRestorePolicy.toSetCookieLines(
                "bad name=x; __Host-token=y; __Secure-token=z; ok=v");

        assertEquals(Arrays.asList(
                "__Secure-token=z; Domain=muse.ai; Path=/; Secure",
                "ok=v; Domain=muse.ai; Path=/; Secure"), lines);
    }

    @Test
    public void keepsEqualsInCookieValueAndSkipsEmptyParts() {
        List<String> lines = CookieRestorePolicy.toSetCookieLines(
                "; token=a=b=c; ; hatch_sess=last");

        assertEquals(Arrays.asList(
                "token=a=b=c; Domain=muse.ai; Path=/; Secure",
                "hatch_sess=last; Domain=muse.ai; Path=/; Secure; HttpOnly"), lines);
    }
}
