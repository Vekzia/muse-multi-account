package com.seekstars.muselauncher;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

import static org.junit.Assert.assertEquals;

public class ProxyCoordinatorTest {
    @Test
    public void newOwnerPreventsQueuedOldRestoreAndOldProbeLoad() {
        ProxyCoordinator coordinator = new ProxyCoordinator();
        List<String> events = new ArrayList<>();
        List<ProxyCoordinator.Completion> pending = new ArrayList<>();
        long probeOwner = coordinator.claim();
        coordinator.submit(probeOwner, done -> pending.add(done),
                ok -> events.add("probe:" + ok));
        coordinator.submit(probeOwner, done -> {
            events.add("stale-restore");
            done.complete(true);
        }, ok -> events.add("restore:" + ok));
        long mainOwner = coordinator.claim();
        coordinator.submit(mainOwner, done -> {
            events.add("main-start");
            done.complete(true);
        }, ok -> events.add("main:" + ok));
        pending.get(0).complete(true);
        assertEquals(Arrays.asList("probe:false", "restore:false", "main-start", "main:true"), events);
    }

    @Test
    public void restoreWaitsForInFlightProbeAndFinishesBeforeMain() {
        ProxyCoordinator coordinator = new ProxyCoordinator();
        List<String> events = new ArrayList<>();
        List<ProxyCoordinator.Completion> pending = new ArrayList<>();
        long owner = coordinator.claim();
        coordinator.submit(owner, done -> pending.add(done), null);
        coordinator.submit(owner, done -> {
            events.add("restore-start");
            pending.add(done);
        }, ok -> events.add("restore:" + ok));
        pending.get(0).complete(true);
        assertEquals(Arrays.asList("restore-start"), events);
        coordinator.submit(coordinator.claim(), done -> {
            events.add("main-start");
            done.complete(true);
        }, ok -> events.add("main:" + ok));
        assertEquals(Arrays.asList("restore-start"), events);
        pending.get(1).complete(true);
        assertEquals(Arrays.asList("restore-start", "restore:false", "main-start", "main:true"), events);
    }

    @Test
    public void serializesGlobalOperationsAndStartsNextAfterCompletion() {
        ProxyCoordinator coordinator = new ProxyCoordinator();
        List<String> events = new ArrayList<>();
        List<ProxyCoordinator.Completion> completions = new ArrayList<>();

        coordinator.submit(done -> {
            events.add("start-a");
            completions.add(done);
        }, ok -> events.add("result-a:" + ok));
        coordinator.submit(done -> {
            events.add("start-b");
            done.complete(false);
        }, ok -> events.add("result-b:" + ok));

        assertEquals(Arrays.asList("start-a"), events);
        completions.get(0).complete(true);
        assertEquals(Arrays.asList(
                "start-a", "result-a:true", "start-b", "result-b:false"), events);
    }

    @Test
    public void completionIsIdempotentWhenControllerReportsTwice() {
        ProxyCoordinator coordinator = new ProxyCoordinator();
        List<Boolean> results = new ArrayList<>();

        coordinator.submit(done -> {
            done.complete(true);
            done.complete(false);
        }, results::add);

        assertEquals(Arrays.asList(true), results);
    }

    @Test
    public void thrownOperationCompletesAsFailureAndReleasesQueue() {
        ProxyCoordinator coordinator = new ProxyCoordinator();
        List<String> events = new ArrayList<>();

        coordinator.submit(done -> { throw new IllegalStateException("controller"); },
                ok -> events.add("first:" + ok));
        coordinator.submit(done -> {
            events.add("second-start");
            done.complete(true);
        }, ok -> events.add("second:" + ok));

        assertEquals(Arrays.asList("first:false", "second-start", "second:true"), events);
    }
}
