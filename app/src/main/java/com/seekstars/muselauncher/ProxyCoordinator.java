package com.seekstars.muselauncher;

import java.util.ArrayDeque;
import java.util.Deque;

/** Serial global proxy writes. All entry points and completions run on one executor. */
final class ProxyCoordinator {
    interface Completion { void complete(boolean ok); }
    interface Operation { void run(Completion completion); }

    private final Deque<Runnable> queue = new ArrayDeque<>();
    private boolean busy;
    private long owner;

    long claim() { return ++owner; }

    void submit(long expectedOwner, Operation operation, Completion callback) {
        submit(done -> {
            if (owner != expectedOwner) done.complete(false);
            else operation.run(done);
        }, ok -> {
            if (callback != null) callback.complete(ok && owner == expectedOwner);
        });
    }

    void submit(Operation operation, Completion callback) {
        queue.addLast(() -> {
            boolean[] completed = {false};
            Completion done = ok -> {
                if (completed[0]) return;
                completed[0] = true;
                try {
                    if (callback != null) callback.complete(ok);
                } finally {
                    busy = false;
                    drain();
                }
            };
            try {
                operation.run(done);
            } catch (RuntimeException failure) {
                done.complete(false);
            }
        });
        drain();
    }

    private void drain() {
        if (busy || queue.isEmpty()) return;
        busy = true;
        queue.removeFirst().run();
    }
}
