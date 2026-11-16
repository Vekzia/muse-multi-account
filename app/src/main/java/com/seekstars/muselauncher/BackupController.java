package com.seekstars.muselauncher;

import android.app.Activity;
import android.content.ContentResolver;
import android.content.Intent;
import android.net.Uri;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.webkit.CookieManager;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.Toast;

import androidx.appcompat.app.AlertDialog;
import androidx.webkit.Profile;
import androidx.webkit.ProfileStore;

import java.io.ByteArrayOutputStream;
import java.io.Closeable;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.lang.ref.WeakReference;
import java.nio.ByteBuffer;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.atomic.AtomicReference;

/**
 * Activity-scoped backup UI and SAF transport. All public methods and Callbacks run on main.
 * Keep this instance through MainActivity's existing configChanges; do not recreate on rotation.
 * Call destroy() from onDestroy. Pending payloads are intentionally never put in a Bundle.
 */
public final class BackupController {
    public static final int REQ_EXPORT = 10003;
    public static final int REQ_IMPORT = 10004;
    private static final int MAX_BYTES = 16 * 1024 * 1024;
    private static final String COOKIE_URL = "https://muse.ai/";

    public interface Callbacks {
        /** Destroy these WebViews before replacement; keep their Profiles until purgeAccount. */
        void beforeReplace(List<Long> ids);
        /** Called only for store.importAccounts(...).removedIds, after the store commit. */
        void purgeAccount(long id);
        /** Refresh UI after all Cookie callbacks and flushes. Merge must preserve old page state. */
        void afterImport();
    }

    private enum Stage { IDLE, DIALOG, WORKING, EXPORT_PICKER, IMPORT_PICKER, COOKIES }
    private final WeakReference<Activity> activity;
    private final AccountsStore store;
    private final ProfileStore profiles;
    private Callbacks callbacks;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService executor = Executors.newSingleThreadExecutor(r -> {
        Thread thread = new Thread(r, "muse-backup");
        thread.setDaemon(true);
        return thread;
    });
    private final StreamSlot streams = new StreamSlot();
    private Stage stage = Stage.IDLE;
    private volatile boolean destroyed;
    private long operation;
    private long taskSequence;
    private Future<?> task;
    private Completion<?> completion;
    private AlertDialog dialog;
    private PasswordPrompt passwordPrompt;
    private ExportPayload pendingExport;
    private RestoreBatch restoreBatch;

    public BackupController(Activity activity, AccountsStore store, ProfileStore profiles,
                            Callbacks callbacks) {
        if (activity == null || store == null || profiles == null || callbacks == null) {
            throw new IllegalArgumentException("BackupController dependencies are required");
        }
        this.activity = new WeakReference<>(activity);
        this.store = store;
        this.profiles = profiles;
        this.callbacks = callbacks;
    }

    public void startExport() {
        requireMain();
        if (!begin()) return;
        if (store.snapshot().isEmpty()) {
            toast(R.string.bkc_export_empty);
            finishOperation();
            return;
        }
        Activity owner = owner();
        String[] modes = {owner.getString(R.string.bkc_mode_config),
                owner.getString(R.string.bkc_mode_cookies), owner.getString(R.string.bkc_mode_encrypted)};
        AlertDialog choices = new AlertDialog.Builder(owner).setTitle(R.string.bkc_export_title)
                .setItems(modes, (d, which) -> {
                    detachDialog();
                    if (which == 2) showPassword(true, null);
                    else prepareExport(which == 1, null, null);
                }).setNegativeButton(R.string.bkc_cancel, (d, w) -> finishOperation()).create();
        showDialog(choices);
    }

    public void startImport() {
        requireMain();
        if (!begin()) return;
        stage = Stage.IMPORT_PICKER;
        try {
            owner().startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT)
                    .addCategory(Intent.CATEGORY_OPENABLE).setType("*/*"), REQ_IMPORT);
        } catch (RuntimeException error) {
            fail(R.string.bkc_picker_failed);
        }
    }

    /** Returns true for the two owned request codes, including canceled/stale results. */
    public boolean onActivityResult(int requestCode, int resultCode, Intent data) {
        requireMain();
        if (requestCode != REQ_EXPORT && requestCode != REQ_IMPORT) return false;
        if (owner() == null) return true;
        Stage expected = requestCode == REQ_EXPORT ? Stage.EXPORT_PICKER : Stage.IMPORT_PICKER;
        if (stage != expected) return true;
        Uri uri = data == null ? null : data.getData();
        if (resultCode != Activity.RESULT_OK || uri == null) {
            finishOperation();
            return true;
        }
        ContentResolver resolver = owner().getApplicationContext().getContentResolver();
        StreamSlot slot = streams;
        stage = Stage.WORKING;
        if (requestCode == REQ_EXPORT) {
            ExportPayload payload = pendingExport;
            pendingExport = null;
            if (payload == null) { finishOperation(); return true; }
            run(() -> { writeBytes(resolver, uri, payload.bytes, slot); return payload.count; },
                    (count, error) -> {
                        if (error != null) fail(errorResource(error, R.string.bkc_export_failed));
                        else { toast(R.string.bkc_export_done, count); finishOperation(); }
                    });
        } else {
            run(() -> readText(resolver, uri, slot), (text, error) -> {
                if (error != null) { fail(errorResource(error, R.string.bkc_import_bad)); return; }
                if (BackupCrypto.isEncrypted(text)) showPassword(false, text);
                else parseImport(text, null, null);
            });
        }
        return true;
    }

    public void destroy() {
        requireMain();
        if (destroyed) return;
        destroyed = true;
        operation++;
        taskSequence++;
        main.removeCallbacksAndMessages(null);
        if (task != null) task.cancel(true);
        task = null;
        completion = null;
        callbacks = null;
        pendingExport = null;
        restoreBatch = null;
        closeDialog();
        executor.shutdownNow();
        streams.cancel();
        activity.clear();
    }

    private boolean begin() {
        if (owner() == null) return false;
        if (stage != Stage.IDLE) { toast(R.string.bkc_busy); return false; }
        operation++;
        stage = Stage.DIALOG;
        return true;
    }

    private void prepareExport(boolean includeCookies, String password, PasswordPrompt prompt) {
        List<Account> snapshot = store.snapshot();
        Map<Long, String> cookies = new LinkedHashMap<>();
        if (includeCookies) {
            for (Account account : snapshot) {
                try {
                    Profile profile = profiles.getProfile("acct_" + account.id);
                    if (profile == null) continue;
                    String header = profile.getCookieManager().getCookie(COOKIE_URL);
                    if (BackupCodec.sanitizeCookie(header) != null) cookies.put(account.id, header);
                } catch (RuntimeException ignored) { /* Missing profile does not prevent configuration backup. */ }
            }
        }
        stage = Stage.WORKING;
        run(() -> {
            String json = BackupCodec.toJson(snapshot, cookies, System.currentTimeMillis());
            // Do not silently export a partially serialized snapshot.
            BackupCodec.Snapshot check = CookieRestorePolicy.parseForImport(json);
            if (check.accounts.size() != snapshot.size()) throw new IOException();
            checkSize(json.getBytes(StandardCharsets.UTF_8));
            String text = password == null ? json : BackupCrypto.encrypt(json, password);
            byte[] bytes = text.getBytes(StandardCharsets.UTF_8);
            checkSize(bytes);
            return new ExportPayload(bytes, snapshot.size(), password != null);
        }, (payload, error) -> {
            if (error != null) {
                int message = errorResource(error, R.string.bkc_export_failed);
                if (prompt != null) prompt.error(message); else fail(message);
                return;
            }
            closeDialog();
            pendingExport = payload;
            stage = Stage.EXPORT_PICKER;
            String stamp = new SimpleDateFormat("yyyyMMdd-HHmm", Locale.US).format(new Date());
            try {
                owner().startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT)
                        .addCategory(Intent.CATEGORY_OPENABLE)
                        .setType(payload.encrypted ? "application/octet-stream" : "application/json")
                        .putExtra(Intent.EXTRA_TITLE, "muse-accounts-" + stamp
                                + (payload.encrypted ? ".mbak" : ".json")), REQ_EXPORT);
            } catch (RuntimeException error1) { fail(R.string.bkc_picker_failed); }
        });
    }

    private void parseImport(String text, String password, PasswordPrompt prompt) {
        stage = Stage.WORKING;
        run(() -> {
            String json = password == null ? text : BackupCrypto.decrypt(text, password);
            checkSize(json.getBytes(StandardCharsets.UTF_8));
            return CookieRestorePolicy.parseForImport(json);
        }, (snapshot, error) -> {
            if (error != null) {
                int message = errorResource(error, R.string.bkc_import_bad);
                if (prompt != null) prompt.error(message); else fail(message);
                return;
            }
            closeDialog();
            showImportConfirmation(snapshot);
        });
    }

    private void showImportConfirmation(BackupCodec.Snapshot snapshot) {
        Activity owner = owner();
        stage = Stage.DIALOG;
        AlertDialog choices = new AlertDialog.Builder(owner).setTitle(R.string.bkc_import_title)
                .setMessage(owner.getString(R.string.bkc_import_summary, snapshot.accounts.size(),
                        snapshot.cookies.size(), owner.getString(R.string.bkc_cookie_limits)))
                .setNegativeButton(R.string.bkc_cancel, (d, w) -> finishOperation())
                .setPositiveButton(R.string.bkc_merge, (d, w) -> {
                    detachDialog();
                    importAccounts(snapshot, false);
                })
                .setNeutralButton(R.string.bkc_replace, (d, w) -> {
                    detachDialog();
                    showReplaceConfirmation(snapshot);
                }).create();
        showDialog(choices);
    }

    private void showReplaceConfirmation(BackupCodec.Snapshot snapshot) {
        Activity owner = owner();
        AlertDialog confirm = new AlertDialog.Builder(owner).setTitle(R.string.bkc_replace_title)
                .setMessage(owner.getString(R.string.bkc_replace_confirm, store.snapshot().size(),
                        snapshot.accounts.size(), owner.getString(R.string.bkc_cookie_limits)))
                .setNegativeButton(R.string.bkc_cancel, (d, w) -> finishOperation())
                .setPositiveButton(R.string.bkc_replace, (d, w) -> {
                    detachDialog();
                    importAccounts(snapshot, true);
                }).create();
        showDialog(confirm);
    }

    private void importAccounts(BackupCodec.Snapshot snapshot, boolean replace) {
        if (owner() == null) return;
        if (!replace && snapshot.accounts.isEmpty()) {
            toast(R.string.bkc_import_empty_merge);
            finishOperation();
            return;
        }
        stage = Stage.WORKING;
        AccountsStore.ImportOutcome outcome;
        try {
            if (replace) {
                List<Long> oldIds = new ArrayList<>();
                for (Account account : store.snapshot()) oldIds.add(account.id);
                callbacks.beforeReplace(Collections.unmodifiableList(oldIds));
                if (owner() == null) return;
            }
            // Keep store mutation and its host cleanup atomic with respect to Activity lifecycle.
            // The store's persistence policy remains its existing responsibility.
            outcome = store.importAccounts(snapshot.accounts, replace);
        } catch (RuntimeException error) {
            fail(R.string.bkc_import_failed);
            return;
        }
        boolean cleanupFailed = false;
        for (long id : outcome.removedIds) {
            if (owner() == null) return;
            try { callbacks.purgeAccount(id); }
            catch (RuntimeException error) { cleanupFailed = true; }
        }
        restoreCookies(snapshot, outcome, cleanupFailed);
    }

    private void restoreCookies(BackupCodec.Snapshot snapshot, AccountsStore.ImportOutcome outcome,
                                boolean cleanupFailed) {
        List<CookieWrite> writes = new ArrayList<>();
        List<Long> ids = new ArrayList<>();
        Map<Long, CookieManager> managers = new LinkedHashMap<>();
        int candidateAccounts = 0;
        for (Map.Entry<Long, String> entry : snapshot.cookies.entrySet()) {
            Long id = outcome.idMap.get(entry.getKey());
            if (id == null) continue; // Never write cookies into skipped or untouched accounts.
            candidateAccounts++;
            List<String> lines = CookieRestorePolicy.toSetCookieLines(entry.getValue());
            if (lines.isEmpty()) continue;
            CookieManager manager = null;
            try {
                Profile profile = profiles.getOrCreateProfile("acct_" + id);
                if (profile != null) manager = profile.getCookieManager();
            } catch (RuntimeException ignored) { }
            if (manager != null) managers.put(id, manager);
            for (String line : lines) {
                writes.add(new CookieWrite(manager, line));
                ids.add(id);
            }
        }
        RestoreBatch batch = new RestoreBatch(operation, outcome, new CookieRestorePolicy.Results(ids),
                new ArrayList<>(managers.values()), candidateAccounts, cleanupFailed);
        restoreBatch = batch;
        stage = Stage.COOKIES;
        WeakReference<BackupController> weak = new WeakReference<>(this);
        long restoreOperation = batch.operation;
        for (int i = 0; i < writes.size(); i++) {
            CookieWrite write = writes.get(i);
            final int index = i;
            if (write.manager == null) { batch.results.record(i, false); continue; }
            try {
                write.manager.setCookie(COOKIE_URL, write.line, accepted -> {
                    BackupController controller = weak.get();
                    if (controller != null) controller.cookieResult(restoreOperation, index,
                            Boolean.TRUE.equals(accepted));
                });
            } catch (RuntimeException error) { batch.results.record(i, false); }
        }
        batch.dispatched = true;
        if (batch.results.isComplete()) flushCookies(batch);
    }

    private void cookieResult(long token, int index, boolean accepted) {
        if (Looper.myLooper() != Looper.getMainLooper()) {
            post(weak -> weak.cookieResult(token, index, accepted));
            return;
        }
        RestoreBatch batch = restoreBatch;
        if (owner() == null || batch == null || token != operation || batch.flushing) return;
        batch.results.record(index, accepted);
        if (batch.dispatched && batch.results.isComplete()) flushCookies(batch);
    }

    private void flushCookies(RestoreBatch batch) {
        if (batch.flushing || restoreBatch != batch) return;
        batch.flushing = true;
        List<CookieManager> managers = batch.managers;
        run(() -> {
            boolean allFlushed = true;
            for (CookieManager manager : managers) {
                if (Thread.currentThread().isInterrupted()) throw new IOException();
                try { manager.flush(); } catch (RuntimeException error) { allFlushed = false; }
            }
            return allFlushed;
        }, (flushed, error) -> {
            if (restoreBatch != batch) return;
            // Config import is committed even when all cookies fail. The message distinguishes it.
            toast(R.string.bkc_import_done, batch.outcome.added, batch.outcome.skipped);
            if (batch.candidateAccounts > 0) {
                if (error != null || !Boolean.TRUE.equals(flushed)) toast(R.string.bkc_cookie_flush_failed);
                else if (batch.results.acceptedCookies() == 0) toast(R.string.bkc_cookie_failed);
                else toast(R.string.bkc_cookie_result, batch.results.restoredAccounts(),
                            batch.candidateAccounts - batch.results.restoredAccounts());
            }
            if (batch.cleanupFailed) toast(R.string.bkc_cleanup_failed);
            Callbacks done = callbacks;
            finishOperation(); // Clear before callback, so reentrancy cannot deliver it twice.
            if (owner() != null && done != null) done.afterImport();
        });
    }

    private void showPassword(boolean exporting, String encrypted) {
        stage = Stage.DIALOG;
        PasswordPrompt prompt = new PasswordPrompt(exporting, encrypted);
        passwordPrompt = prompt;
        showDialog(prompt.window);
        prompt.window.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v -> prompt.submit());
    }

    private final class PasswordPrompt {
        final boolean exporting;
        final String encrypted;
        final EditText input;
        final AlertDialog window;
        boolean running;

        PasswordPrompt(boolean exporting, String encrypted) {
            this.exporting = exporting;
            this.encrypted = encrypted;
            Activity owner = owner();
            input = new EditText(owner);
            input.setSingleLine(true);
            input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
            input.setHint(R.string.bkc_password_hint);
            FrameLayout wrap = new FrameLayout(owner);
            int inset = Math.round(20 * owner.getResources().getDisplayMetrics().density);
            wrap.setPadding(inset, inset / 2, inset, 0);
            wrap.addView(input);
            window = new AlertDialog.Builder(owner)
                    .setTitle(exporting ? R.string.bkc_export_password : R.string.bkc_import_password)
                    .setView(wrap).setNegativeButton(R.string.bkc_cancel, (d, w) -> finishOperation())
                    .setPositiveButton(R.string.bkc_continue, null).create();
        }

        void submit() {
            if (running || owner() == null) return;
            String password = input.getText().toString();
            if (password.isEmpty() || (exporting && password.length() < 6)) {
                input.setError(owner().getString(exporting ? R.string.bkc_password_short : R.string.bkc_password_empty));
                return;
            }
            running = true;
            input.setError(null);
            input.setEnabled(false);
            window.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(false);
            window.getButton(AlertDialog.BUTTON_POSITIVE).setText(R.string.bkc_processing);
            if (exporting) prepareExport(true, password, this);
            else parseImport(encrypted, password, this);
        }

        void error(int resource) {
            if (owner() == null || passwordPrompt != this) return;
            running = false;
            stage = Stage.DIALOG;
            input.setEnabled(true);
            input.setError(owner().getString(resource));
            window.getButton(AlertDialog.BUTTON_POSITIVE).setEnabled(true);
            window.getButton(AlertDialog.BUTTON_POSITIVE).setText(R.string.bkc_continue);
        }
    }

    private interface Completion<T> { void accept(T value, Exception error); }
    private interface MainAction { void accept(BackupController controller); }

    /** Workers capture only operation data and a weak controller reference, never Activity/dialogs. */
    private <T> void run(Callable<T> work, Completion<T> done) {
        if (owner() == null) return;
        completion = done;
        long sequence = ++taskSequence;
        long token = operation;
        WeakReference<BackupController> weak = new WeakReference<>(this);
        Handler handler = main;
        task = executor.submit(() -> {
            T value = null;
            Exception error = null;
            try { value = work.call(); } catch (Exception failure) { error = failure; }
            T result = value;
            Exception failure = error;
            BackupController controller = weak.get();
            if (controller == null || controller.destroyed || Thread.currentThread().isInterrupted()) return;
            handler.post(() -> {
                BackupController target = weak.get();
                if (target != null) target.deliver(token, sequence, result, failure);
            });
        });
    }

    @SuppressWarnings("unchecked")
    private <T> void deliver(long token, long sequence, T value, Exception error) {
        if (owner() == null || token != operation || sequence != taskSequence) return;
        Completion<T> done = (Completion<T>) completion;
        completion = null;
        task = null;
        if (done != null) done.accept(value, error);
    }

    private void post(MainAction action) {
        WeakReference<BackupController> weak = new WeakReference<>(this);
        main.post(() -> {
            BackupController target = weak.get();
            if (target != null && target.owner() != null) action.accept(target);
        });
    }

    private void finishOperation() {
        operation++;
        taskSequence++;
        if (task != null) task.cancel(true);
        task = null;
        completion = null;
        restoreBatch = null;
        pendingExport = null;
        closeDialog();
        stage = Stage.IDLE;
    }

    private void fail(int message) { toast(message); finishOperation(); }

    private void showDialog(AlertDialog window) {
        if (owner() == null) return;
        dialog = window;
        window.setOnCancelListener(d -> finishOperation());
        window.show();
    }

    private void detachDialog() {
        if (dialog != null) dialog.setOnCancelListener(null);
        dialog = null;
    }

    private void closeDialog() {
        if (passwordPrompt != null) passwordPrompt.input.getText().clear();
        passwordPrompt = null;
        AlertDialog current = dialog;
        dialog = null;
        if (current != null) {
            current.setOnCancelListener(null);
            current.dismiss();
        }
    }

    private Activity owner() {
        Activity current = activity.get();
        return destroyed || current == null || current.isFinishing() || current.isDestroyed() ? null : current;
    }

    private void toast(int resource, Object... args) {
        Activity current = owner();
        if (current != null) Toast.makeText(current.getApplicationContext(),
                current.getString(resource, args), Toast.LENGTH_LONG).show();
    }

    private static int errorResource(Exception error, int fallback) {
        if (error instanceof TooLarge) return R.string.bkc_file_too_large;
        if (error instanceof GeneralSecurityException) return R.string.bkc_password_wrong;
        if (error instanceof CookieRestorePolicy.InvalidBackup) {
            return ((CookieRestorePolicy.InvalidBackup) error).reason
                    == CookieRestorePolicy.InvalidBackup.Reason.DUPLICATE_IDS
                    ? R.string.bkc_duplicate_ids : R.string.bkc_import_bad;
        }
        return fallback; // Do not expose exception text: providers/crypto may include private data.
    }

    private static void requireMain() {
        if (Looper.myLooper() != Looper.getMainLooper()) throw new IllegalStateException("Main thread required");
    }

    private static void checkSize(byte[] bytes) throws TooLarge {
        if (bytes.length > MAX_BYTES) throw new TooLarge();
    }

    private static String readText(ContentResolver resolver, Uri uri, StreamSlot slot) throws Exception {
        try (InputStream input = resolver.openInputStream(uri);
             ByteArrayOutputStream bytes = new ByteArrayOutputStream()) {
            if (input == null) throw new IOException();
            slot.attach(input);
            try {
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) {
                    if (Thread.currentThread().isInterrupted()) throw new IOException();
                    if (count > MAX_BYTES - bytes.size()) throw new TooLarge();
                    bytes.write(buffer, 0, count);
                }
                return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                        .onUnmappableCharacter(CodingErrorAction.REPORT)
                        .decode(ByteBuffer.wrap(bytes.toByteArray())).toString();
            } finally { slot.detach(input); }
        }
    }

    private static void writeBytes(ContentResolver resolver, Uri uri, byte[] bytes, StreamSlot slot) throws Exception {
        checkSize(bytes);
        try (OutputStream output = resolver.openOutputStream(uri, "wt")) {
            if (output == null) throw new IOException();
            slot.attach(output);
            try {
                for (int offset = 0; offset < bytes.length; offset += 8192) {
                    if (Thread.currentThread().isInterrupted()) throw new IOException();
                    output.write(bytes, offset, Math.min(8192, bytes.length - offset));
                }
                output.flush();
            } finally { slot.detach(output); }
        }
    }

    private static final class TooLarge extends IOException { }
    private static final class ExportPayload {
        final byte[] bytes;
        final int count;
        final boolean encrypted;
        ExportPayload(byte[] bytes, int count, boolean encrypted) {
            this.bytes = bytes; this.count = count; this.encrypted = encrypted;
        }
    }
    private static final class CookieWrite {
        final CookieManager manager;
        final String line;
        CookieWrite(CookieManager manager, String line) { this.manager = manager; this.line = line; }
    }
    private static final class RestoreBatch {
        final long operation;
        final AccountsStore.ImportOutcome outcome;
        final CookieRestorePolicy.Results results;
        final List<CookieManager> managers;
        final int candidateAccounts;
        final boolean cleanupFailed;
        boolean dispatched, flushing;
        RestoreBatch(long operation, AccountsStore.ImportOutcome outcome, CookieRestorePolicy.Results results,
                     List<CookieManager> managers, int candidateAccounts, boolean cleanupFailed) {
            this.operation = operation; this.outcome = outcome; this.results = results;
            this.managers = managers; this.candidateAccounts = candidateAccounts; this.cleanupFailed = cleanupFailed;
        }
    }

    /** Closing a remote provider stream may block; destruction closes it without retaining Activity. */
    private static final class StreamSlot {
        private final AtomicReference<Closeable> active = new AtomicReference<>();
        private volatile boolean canceled;
        void attach(Closeable stream) throws IOException {
            active.set(stream);
            if (canceled) { close(active.getAndSet(null)); throw new IOException(); }
        }
        void detach(Closeable stream) { active.compareAndSet(stream, null); }
        void cancel() {
            canceled = true;
            Closeable stream = active.getAndSet(null);
            if (stream == null) return;
            Thread closer = new Thread(() -> close(stream), "muse-backup-close");
            closer.setDaemon(true);
            closer.start();
        }
        private static void close(Closeable stream) {
            if (stream != null) try { stream.close(); } catch (IOException ignored) { }
        }
    }
}
