package com.seekstars.muselauncher;

import org.junit.Test;
import static org.junit.Assert.*;

/** These tests catch stale apply commits, background applies and reset retry budgets. */
public class WebViewHostSessionTest {
    @Test public void initialRequestWaitsForResumeAndDoesNotInventAnAccount() {
        WebViewHostSession s = new WebViewHostSession();
        assertNull(s.take());
        s.resume();
        assertNull(s.take());
        s.pause();
        s.request(17, true, false, true);
        assertNull(s.take());
        s.resume();
        WebViewHostSession.Request request = s.take();
        assertNotNull(request);
        assertEquals(17, request.id);
        assertTrue(request.animate);
        assertTrue(s.complete(request));
    }

    @Test public void coalescesLatestRequestAndAllowsOnlyOneApplyInFlight() {
        WebViewHostSession s = new WebViewHostSession();
        s.resume();
        s.request(1, false, false, true);
        WebViewHostSession.Request first = s.take();
        assertNotNull(first);
        s.request(2, true, false, true);
        s.request(3, false, true, true);
        assertNull(s.take());
        assertFalse(s.complete(first));
        WebViewHostSession.Request last = s.take();
        assertEquals(3, last.id);
        assertTrue(last.reload);
        // Duplicate/out-of-order completion must not release the real in-flight request.
        assertFalse(s.complete(first));
        assertNull(s.take());
        assertTrue(s.complete(last));
    }

    @Test public void pauseInvalidatesApplyAndResumeQueuesOnlyOneFreshAttempt() {
        WebViewHostSession s = new WebViewHostSession();
        s.resume();
        s.request(1, false, false, true);
        WebViewHostSession.Request first = s.take();
        assertNotNull(first);
        s.pause();
        assertFalse(s.complete(first));
        assertNull(s.take());
        s.resume();
        s.resume();
        WebViewHostSession.Request resumed = s.take();
        assertNotNull(resumed);
        assertTrue(s.complete(resumed));
        assertNull(s.take());
    }

    @Test public void activationAfterResumeSupersedesRefreshBeforeDispatch() {
        WebViewHostSession s = new WebViewHostSession();
        s.resume();
        s.request(1, false, false, true);
        assertTrue(s.complete(s.take()));
        s.pause();
        s.resume();
        s.request(9, true, false, true);
        assertEquals(9, s.take().id);
    }

    @Test public void oneAlternativePerExplicitAttemptSurvivesFinishAndResume() {
        WebViewHostSession s = new WebViewHostSession();
        s.resume();
        s.request(7, false, false, true);
        assertTrue(s.complete(s.take()));
        assertTrue(s.tryAlternative(7));
        s.request(7, false, true, false);
        assertTrue(s.complete(s.take()));
        assertFalse(s.tryAlternative(7));
        s.pause();
        assertFalse(s.tryAlternative(7));
        s.resume();
        assertTrue(s.complete(s.take()));
        assertFalse(s.tryAlternative(7));
        s.request(7, false, true, true);
        assertTrue(s.complete(s.take()));
        assertTrue(s.tryAlternative(7));
        assertFalse(s.tryAlternative(8));
    }

    @Test public void pendingSwitchCannotFailoverPreviousAccount() {
        WebViewHostSession s = new WebViewHostSession();
        s.resume();
        s.request(1, false, false, true);
        assertTrue(s.complete(s.take()));
        s.request(2, false, false, true);
        assertFalse(s.tryAlternative(1));
        assertFalse(s.tryAlternative(2));
        assertTrue(s.complete(s.take()));
        assertTrue(s.tryAlternative(2));
    }

    @Test public void resumeWaitsForPrePauseApplyAndCannotStartASecondFlight() {
        WebViewHostSession s = new WebViewHostSession();
        s.resume();
        s.request(1, true, false, true);
        WebViewHostSession.Request first = s.take();
        s.pause();
        s.resume();
        assertNull(s.take());
        assertFalse(s.complete(first));
        WebViewHostSession.Request resumed = s.take();
        assertNotNull(resumed);
        assertEquals(1, resumed.id);
        assertTrue(s.complete(resumed));
    }

    @Test public void releasingOldInflightAccountPreservesNewestQueuedAccount() {
        WebViewHostSession s = new WebViewHostSession();
        s.resume();
        s.request(1, false, false, true);
        WebViewHostSession.Request old = s.take();
        s.request(2, true, false, true);
        s.forget(1);
        assertNull(s.take());
        assertFalse(s.complete(old));
        WebViewHostSession.Request next = s.take();
        assertEquals(2, next.id);
        assertTrue(s.complete(next));
    }

    @Test public void resumeDoesNotReplayConsumedAnimationOrExplicitReload() {
        WebViewHostSession s = new WebViewHostSession();
        s.resume();
        s.request(1, true, true, true);
        assertTrue(s.complete(s.take()));
        s.pause();
        s.resume();
        WebViewHostSession.Request refresh = s.take();
        assertFalse(refresh.animate);
        assertFalse(refresh.reload);
    }

    @Test public void oldCallbackTokenIsRejectedAfterSwitchPauseReleaseAndDestroy() {
        WebViewHostSession s = new WebViewHostSession();
        s.resume();
        s.request(1, false, false, true);
        WebViewHostSession.Request old = s.take();
        assertTrue(s.complete(old));
        assertTrue(s.accepts(old));
        s.request(2, false, false, true);
        assertFalse(s.accepts(old));
        WebViewHostSession.Request next = s.take();
        assertTrue(s.complete(next));
        s.pause();
        assertFalse(s.accepts(next));
        s.resume();
        WebViewHostSession.Request refreshed = s.take();
        assertTrue(s.complete(refreshed));
        s.forget(2);
        assertFalse(s.accepts(refreshed));
        s.destroy();
        assertFalse(s.accepts(refreshed));
    }

    @Test public void releaseOfDesiredAccountDoesNotReappearOnResume() {
        WebViewHostSession s = new WebViewHostSession();
        s.resume();
        s.request(1, true, false, true);
        assertTrue(s.complete(s.take()));
        s.forget(1);
        s.pause();
        s.resume();
        assertNull(s.take());
        assertEquals(-1, s.desiredId());
    }

    @Test public void forgetAndDestroyDiscardRequestsWithoutReleasingInflightEarly() {
        WebViewHostSession s = new WebViewHostSession();
        s.resume();
        s.request(1, false, false, true);
        WebViewHostSession.Request first = s.take();
        assertNotNull(first);
        s.forget(1);
        assertEquals(-1, s.desiredId());
        assertFalse(s.complete(first));
        assertNull(s.take());
        s.request(2, false, false, true);
        WebViewHostSession.Request second = s.take();
        s.destroy();
        assertFalse(s.complete(second));
        s.resume();
        s.request(3, true, false, true);
        assertNull(s.take());
    }
}
