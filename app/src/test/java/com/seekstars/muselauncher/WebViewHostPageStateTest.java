package com.seekstars.muselauncher;

import org.junit.Test;
import static org.junit.Assert.*;

public class WebViewHostPageStateTest {
    @Test public void errorPageStartedAndFinishedKeepFailureUntilExplicitLoad() {
        WebViewHostPageState page = new WebViewHostPageState();
        page.begin();
        page.failed();
        page.started();
        page.finished();
        assertTrue(page.isFailed());
        assertTrue(page.needsLoad());
        page.begin();
        page.started();
        page.finished();
        assertFalse(page.isFailed());
        assertFalse(page.needsLoad());
    }

    @Test public void suspendRemembersInterruptedLoadButRetainsFinishedPage() {
        WebViewHostPageState page = new WebViewHostPageState();
        page.begin();
        page.suspend();
        assertTrue(page.needsLoad());
        page.begin();
        page.finished();
        page.suspend();
        assertFalse(page.needsLoad());
        page.invalidate();
        assertTrue(page.needsLoad());
    }

    @Test public void errorFinishCannotReplenishActualSessionsAlternativeBudget() {
        WebViewHostSession session = new WebViewHostSession();
        WebViewHostPageState page = new WebViewHostPageState();
        session.resume();
        session.request(1, false, false, true);
        assertTrue(session.complete(session.take()));
        page.begin();
        page.failed();
        assertTrue(session.tryAlternative(1));
        session.request(1, false, true, false);
        assertTrue(session.complete(session.take()));
        page.begin();
        page.failed();
        page.started();
        page.finished();
        assertTrue(page.isFailed());
        assertFalse(session.tryAlternative(1));
        session.request(1, false, true, true);
        assertTrue(session.complete(session.take()));
        page.begin();
        page.failed();
        assertTrue(session.tryAlternative(1));
    }
}
