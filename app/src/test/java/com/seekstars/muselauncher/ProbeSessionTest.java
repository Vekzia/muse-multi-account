package com.seekstars.muselauncher;

import org.junit.Test;
import static org.junit.Assert.*;

public class ProbeSessionTest {
    @Test public void loadWaitsForSuccessfulProxyCompletion() {
        ProbeSession session = new ProbeSession();
        long first = session.begin();
        assertFalse(session.pageFinished(first, true));
        assertTrue(session.proxyApplied(first, true));
        assertFalse(session.proxyApplied(first, true));
        assertTrue(session.pageFinished(first, true));
        assertFalse(session.finish(first));
    }

    @Test public void errorThenFinishNeverCompletesFollowingAttempt() {
        ProbeSession session = new ProbeSession();
        long first = session.begin();
        assertTrue(session.proxyApplied(first, true));
        assertTrue(session.finish(first));
        long second = session.begin();
        assertFalse(session.pageFinished(first, true));
        assertFalse(session.finish(first));
        assertTrue(session.proxyApplied(second, true));
        assertTrue(session.pageFinished(second, true));
    }

    @Test public void oneActiveAttemptAtATimeAndCancelInvalidatesLateApply() {
        ProbeSession session = new ProbeSession();
        long first = session.begin();
        assertEquals(0, session.begin());
        session.cancel();
        assertFalse(session.proxyApplied(first, true));
        assertFalse(session.finish(first));
        assertTrue(session.begin() > first);
    }

    @Test public void timeoutWhileApplyingCannotLoadAfterNextAttemptBegins() {
        ProbeSession session = new ProbeSession();
        long timedOut = session.begin();
        assertTrue(session.finish(timedOut));
        long next = session.begin();
        assertFalse(session.proxyApplied(timedOut, true));
        assertFalse(session.pageFinished(timedOut, true));
        assertTrue(session.proxyApplied(next, true));
        assertTrue(session.pageFinished(next, true));
    }

    @Test public void wrongEndpointAndFailedApplicationNeverPass() {
        ProbeSession session = new ProbeSession();
        long first = session.begin();
        assertFalse(session.proxyApplied(first, false));
        assertFalse(session.pageFinished(first, true));
        assertTrue(session.finish(first));
        long next = session.begin();
        assertTrue(session.proxyApplied(next, true));
        assertFalse(session.pageFinished(next, false));
        assertTrue(session.finish(next));
    }
}
