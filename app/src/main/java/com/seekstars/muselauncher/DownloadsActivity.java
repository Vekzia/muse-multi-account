package com.seekstars.muselauncher;

import android.app.DownloadManager;
import android.content.ClipData;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.text.format.Formatter;
import android.view.View;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ProgressBar;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import java.text.DateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** DownloadManager work stays off the UI thread; refresh is active only while resumed. */
public final class DownloadsActivity extends AppCompatActivity {
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final ExecutorService worker = Executors.newSingleThreadExecutor();
    private final Map<Long, Row> rows = new LinkedHashMap<>();
    private final Runnable poll = this::refresh;
    private DownloadRepository repository;
    private DownloadManager manager;
    private LinearLayout list;
    private TextView message;
    private Button refreshButton;
    private boolean resumed;
    private int generation;
    private AlertDialog actionDialog;

    @Override protected void onCreate(Bundle state) {
        super.onCreate(state);
        repository = new DownloadRepository(this);
        manager = (DownloadManager) getSystemService(DOWNLOAD_SERVICE);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setPadding(dp(16), dp(8), dp(16), dp(16));
        root.setBackgroundColor(getColor(R.color.bg));
        LinearLayout toolbar = new LinearLayout(this);
        Button back = button(R.string.pt_close);
        back.setOnClickListener(v -> finish());
        toolbar.addView(back, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, dp(48)));
        TextView title = text(getString(R.string.pt_downloads_title), 20);
        toolbar.addView(title, new LinearLayout.LayoutParams(0, dp(48), 1));
        root.addView(toolbar);
        root.addView(text(getString(R.string.pt_downloads_note), 14));
        refreshButton = button(R.string.pt_refresh);
        refreshButton.setOnClickListener(v -> refresh());
        root.addView(refreshButton, matchWrap());
        message = text(getString(R.string.pt_loading), 14);
        message.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        root.addView(message, matchWrap());
        ScrollView scroll = new ScrollView(this);
        list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(list, matchWrap());
        root.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        setContentView(root);
    }

    @Override protected void onResume() {
        super.onResume(); resumed = true; refresh();
    }
    @Override protected void onPause() {
        resumed = false; generation++;
        handler.removeCallbacksAndMessages(null);
        super.onPause();
    }
    @Override protected void onDestroy() {
        resumed = false; generation++;
        handler.removeCallbacksAndMessages(null);
        worker.shutdownNow();
        if (actionDialog != null) actionDialog.dismiss();
        super.onDestroy();
    }

    private void refresh() {
        if (!resumed || isDestroyed()) return;
        handler.removeCallbacks(poll);
        final int request = ++generation;
        refreshButton.setEnabled(false);
        worker.execute(() -> {
            List<DownloadRepository.Entry> entries = null;
            try {
                if (manager != null) entries = repository.query(manager);
            } catch (RuntimeException ignored) { }
            final List<DownloadRepository.Entry> result = entries;
            handler.post(() -> {
                if (!resumed || request != generation || isDestroyed()) return;
                refreshButton.setEnabled(true);
                if (result == null) {
                    message.setText(R.string.pt_query_error); message.setVisibility(View.VISIBLE);
                    return;
                }
                render(result);
                handler.postDelayed(poll, 2000);
            });
        });
    }

    private void render(List<DownloadRepository.Entry> entries) {
        message.setText(R.string.pt_downloads_empty);
        message.setVisibility(entries.isEmpty() ? View.VISIBLE : View.GONE);
        List<Long> ids = new ArrayList<>();
        for (DownloadRepository.Entry entry : entries) ids.add(entry.record.id);
        // Stable views preserve keyboard/TalkBack focus while only progress text updates.
        if (!ids.equals(new ArrayList<>(rows.keySet()))) {
            rows.clear(); list.removeAllViews();
            for (DownloadRepository.Entry entry : entries) {
                Row row = new Row(); rows.put(entry.record.id, row);
                list.addView(row.root, matchWrap());
            }
        }
        for (DownloadRepository.Entry entry : entries) rows.get(entry.record.id).bind(entry);
    }

    private final class Row {
        final LinearLayout root = new LinearLayout(DownloadsActivity.this);
        final TextView name = text("", 16);
        final TextView details = text("", 12);
        final TextView status = text("", 14);
        final TextView bytes = text("", 12);
        final ProgressBar progress = new ProgressBar(DownloadsActivity.this, null, android.R.attr.progressBarStyleHorizontal);
        final Button open = button(R.string.pt_open);
        final Button cancel = button(R.string.pt_cancel_download);
        final Button remove = button(R.string.pt_remove_record);
        DownloadRepository.Entry entry;
        Row() {
            root.setOrientation(LinearLayout.VERTICAL);
            root.setPadding(dp(12), dp(12), dp(12), dp(12));
            root.setBackgroundColor(getColor(R.color.chat_bg));
            root.addView(name, matchWrap()); root.addView(details, matchWrap()); root.addView(status, matchWrap());
            root.addView(progress, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(8)));
            root.addView(bytes, matchWrap());
            LinearLayout actions = new LinearLayout(DownloadsActivity.this);
            actions.addView(open, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            actions.addView(cancel, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            actions.addView(remove, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            root.addView(actions, matchWrap());
            open.setOnClickListener(v -> openFile(entry));
            cancel.setOnClickListener(v -> confirmCancel(entry));
            remove.setOnClickListener(v -> confirmRemove(entry));
        }
        void bind(DownloadRepository.Entry value) {
            entry = value;
            name.setText(value.record.filename);
            details.setText(getString(R.string.pt_download_metadata, value.record.accountId,
                    DateFormat.getDateTimeInstance(DateFormat.SHORT, DateFormat.SHORT).format(new Date(value.record.createdAt)),
                    value.record.sourceUrl));
            String state;
            switch (value.status) {
                case DownloadManager.STATUS_PENDING: state = getString(R.string.pt_pending); break;
                case DownloadManager.STATUS_RUNNING: state = getString(R.string.pt_running); break;
                case DownloadManager.STATUS_PAUSED: state = getString(R.string.pt_paused, value.reason); break;
                case DownloadManager.STATUS_SUCCESSFUL: state = getString(R.string.pt_success); break;
                case DownloadManager.STATUS_FAILED: state = getString(R.string.pt_failed, value.reason); break;
                default: state = getString(R.string.pt_missing);
            }
            status.setText(state);
            progress.setVisibility(value.isActive() ? View.VISIBLE : View.GONE);
            progress.setIndeterminate(value.total <= 0);
            if (value.total > 0) progress.setProgress((int) Math.min(100, Math.max(0, value.downloaded * 100.0 / value.total)));
            progress.setContentDescription(state);
            bytes.setText(getString(R.string.pt_bytes, Formatter.formatFileSize(DownloadsActivity.this, Math.max(0, value.downloaded)),
                    value.total < 0 ? getString(R.string.pt_unknown_size) : Formatter.formatFileSize(DownloadsActivity.this, value.total)));
            open.setVisibility(value.status == DownloadManager.STATUS_SUCCESSFUL ? View.VISIBLE : View.GONE);
            cancel.setVisibility(value.isActive() ? View.VISIBLE : View.GONE);
            open.setContentDescription(getString(R.string.pt_open) + " " + value.record.filename);
            cancel.setContentDescription(getString(R.string.pt_cancel_download) + " " + value.record.filename);
            remove.setContentDescription(getString(R.string.pt_remove_record) + " " + value.record.filename);
        }
    }

    private void openFile(DownloadRepository.Entry entry) {
        if (manager == null || entry == null || !repository.contains(entry.record.id)) return;
        try {
            Uri uri = manager.getUriForDownloadedFile(entry.record.id);
            if (uri == null || !"content".equalsIgnoreCase(uri.getScheme())) { toast(R.string.pt_open_error); return; }
            String mime = manager.getMimeTypeForDownloadedFile(entry.record.id);
            Intent intent = new Intent(Intent.ACTION_VIEW).setDataAndType(uri, mime == null ? "*/*" : mime)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.setClipData(ClipData.newRawUri(entry.record.filename, uri));
            startActivity(intent);
        } catch (RuntimeException e) { toast(R.string.pt_open_error); }
    }

    private void confirmCancel(DownloadRepository.Entry entry) {
        if (entry == null || !entry.isActive()) return;
        showAction(new AlertDialog.Builder(this).setTitle(R.string.pt_cancel_title).setMessage(R.string.pt_cancel_body)
                .setNegativeButton(android.R.string.cancel, null).setPositiveButton(R.string.pt_cancel_download, (d, which) -> {
                    worker.execute(() -> {
                        boolean cancelled = false;
                        try { if (manager != null) cancelled = repository.cancel(manager, entry.record.id); }
                        catch (RuntimeException ignored) { }
                        final boolean result = cancelled;
                        handler.post(() -> {
                            if (!resumed || isDestroyed()) return;
                            if (!result) toast(R.string.pt_cancel_changed);
                            refresh();
                        });
                    });
                }).create());
    }

    private void confirmRemove(DownloadRepository.Entry entry) {
        if (entry == null) return;
        showAction(new AlertDialog.Builder(this).setTitle(R.string.pt_remove_title).setMessage(R.string.pt_remove_body)
                .setNegativeButton(android.R.string.cancel, null).setPositiveButton(R.string.pt_remove_record, (d, which) -> {
                    repository.removeRecord(entry.record.id);
                    refresh();
                }).create());
    }

    private void showAction(AlertDialog dialog) {
        if (actionDialog != null) actionDialog.dismiss();
        actionDialog = dialog; dialog.show();
    }
    private void toast(int text) { Toast.makeText(this, text, Toast.LENGTH_LONG).show(); }
    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
    private LinearLayout.LayoutParams matchWrap() {
        return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
    }
    private Button button(int label) {
        Button button = new Button(this); button.setText(label); button.setAllCaps(false);
        button.setMinHeight(dp(48)); return button;
    }
    private TextView text(String value, int size) {
        TextView text = new TextView(this); text.setText(value); text.setTextSize(size);
        text.setTextColor(getColor(R.color.text_primary)); text.setPadding(0, dp(4), 0, dp(4));
        return text;
    }
}
