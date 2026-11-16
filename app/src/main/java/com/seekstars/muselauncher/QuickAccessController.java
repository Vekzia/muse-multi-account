package com.seekstars.muselauncher;

import android.Manifest;
import android.app.Activity;
import android.app.AlertDialog;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.view.LayoutInflater;
import android.view.View;
import android.widget.Switch;
import android.widget.Toast;

import java.util.List;

/** Owns opt-in settings and notification UI; all callbacks are forwarded by MainActivity. */
public final class QuickAccessController {
    static final String PREFS = "quick_access";
    static final String KEY_NOTIFICATION = "notification_enabled";
    static final String KEY_OVERLAY = "overlay_enabled";
    private static final String CHANNEL_ID = "muse_quick_access";
    private static final String ACTION_STOP_NOTIFICATION = "com.seekstars.muselauncher.action.STOP_QUICK_NOTIFICATION";
    private static final int NOTIFICATION_ID = 7401;
    private static final int REQUEST_NOTIFICATION = 17401;
    private static final int REQUEST_OVERLAY = 17402;
    private static final int REQUEST_OVERLAY_NOTIFICATION = 17403;
    private final Activity activity;
    private final SharedPreferences prefs;
    private AlertDialog settings;
    private Switch notificationSwitch;
    private Switch overlaySwitch;
    private boolean syncing;
    private boolean awaitingOverlay;
    private boolean awaitingNotification;
    private boolean awaitingOverlayNotification;
    private boolean destroyed;
    private final SharedPreferences.OnSharedPreferenceChangeListener preferenceListener =
            (sharedPreferences, key) -> syncControls();

    public QuickAccessController(Activity activity) {
        this.activity = activity;
        prefs = preferences(activity);
        // A killed/non-sticky service is never automatically restarted on app or device launch.
        if (!FloatingSwitchService.isRunning()) prefs.edit().putBoolean(KEY_OVERLAY, false).apply();
        prefs.registerOnSharedPreferenceChangeListener(preferenceListener);
    }

    static SharedPreferences preferences(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    public void showSettings() {
        if (destroyed || activity.isFinishing()) return;
        if (settings != null) settings.dismiss();
        View content = LayoutInflater.from(activity).inflate(R.layout.qa_controller, null);
        notificationSwitch = content.findViewById(R.id.qa_notification);
        overlaySwitch = content.findViewById(R.id.qa_overlay);
        notificationSwitch.setOnCheckedChangeListener((button, checked) -> {
            if (!syncing) setNotificationEnabled(checked);
        });
        overlaySwitch.setOnCheckedChangeListener((button, checked) -> {
            if (!syncing) setOverlayEnabled(checked);
        });
        AlertDialog dialog = new AlertDialog.Builder(activity).setView(content).create();
        settings = dialog;
        content.findViewById(R.id.qa_close).setOnClickListener(v -> dialog.dismiss());
        dialog.setOnDismissListener(dismissed -> {
            if (settings == dialog) {
                notificationSwitch = null;
                overlaySwitch = null;
                settings = null;
            }
        });
        dialog.show();
        syncControls();
    }

    public void refresh() {
        if (destroyed) return;
        AccountShortcuts.refresh(activity);
        List<Account> accounts = new AccountsStore(activity).all();
        if (accounts.isEmpty()) {
            awaitingOverlay = false;
            prefs.edit().putBoolean(KEY_OVERLAY, false).apply();
            activity.stopService(new Intent(activity, FloatingSwitchService.class));
        } else if (awaitingOverlay && Settings.canDrawOverlays(activity)) {
            awaitingOverlay = false;
            requestOverlayNotificationThenStart();
        }
        if (prefs.getBoolean(KEY_NOTIFICATION, false) && notificationsAllowed(activity, CHANNEL_ID) && !accounts.isEmpty()) {
            showNotification(accounts);
        } else {
            cancelNotification(activity);
            if (!notificationsAllowed(activity, CHANNEL_ID)) {
                prefs.edit().putBoolean(KEY_NOTIFICATION, false).apply();
            }
        }
        if (!Settings.canDrawOverlays(activity)
                || !notificationsAllowed(activity, FloatingSwitchService.CHANNEL_ID)) {
            prefs.edit().putBoolean(KEY_OVERLAY, false).apply();
            activity.stopService(new Intent(activity, FloatingSwitchService.class));
        }
        syncControls();
    }

    private void setNotificationEnabled(boolean enabled) {
        if (!enabled) {
            awaitingNotification = false;
            prefs.edit().putBoolean(KEY_NOTIFICATION, false).apply();
            cancelNotification(activity);
            return;
        }
        if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            awaitingNotification = true;
            activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_NOTIFICATION);
            syncControls();
            return;
        }
        if (!notificationsAllowed(activity, CHANNEL_ID)) {
            prefs.edit().putBoolean(KEY_NOTIFICATION, false).apply();
            showNotificationSettings(CHANNEL_ID);
            syncControls();
            return;
        }
        prefs.edit().putBoolean(KEY_NOTIFICATION, true).apply();
        refresh();
    }

    private void setOverlayEnabled(boolean enabled) {
        if (!enabled) {
            awaitingOverlay = false;
            awaitingOverlayNotification = false;
            prefs.edit().putBoolean(KEY_OVERLAY, false).apply();
            activity.stopService(new Intent(activity, FloatingSwitchService.class));
            syncControls();
            return;
        }
        if (new AccountsStore(activity).all().isEmpty()) {
            toast(R.string.qa_no_accounts);
            syncControls();
            return;
        }
        if (!Settings.canDrawOverlays(activity)) {
            awaitingOverlay = true;
            toast(R.string.qa_overlay_permission);
            try {
                activity.startActivityForResult(new Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                        Uri.parse("package:" + activity.getPackageName())), REQUEST_OVERLAY);
            } catch (RuntimeException ignored) {
                awaitingOverlay = false;
                toast(R.string.qa_overlay_denied);
            }
            syncControls();
            return;
        }
        requestOverlayNotificationThenStart();
        syncControls();
    }

    private void requestOverlayNotificationThenStart() {
        if (Build.VERSION.SDK_INT >= 33 && activity.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) {
            awaitingOverlayNotification = true;
            activity.requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQUEST_OVERLAY_NOTIFICATION);
            return;
        }
        if (!notificationsAllowed(activity, FloatingSwitchService.CHANNEL_ID)) {
            prefs.edit().putBoolean(KEY_OVERLAY, false).apply();
            showNotificationSettings(FloatingSwitchService.CHANNEL_ID);
            syncControls();
            return;
        }
        startOverlay();
    }

    private void startOverlay() {
        if (!Settings.canDrawOverlays(activity) || new AccountsStore(activity).all().isEmpty()
                || !notificationsAllowed(activity, FloatingSwitchService.CHANNEL_ID)) {
            prefs.edit().putBoolean(KEY_OVERLAY, false).apply();
            return;
        }
        prefs.edit().putBoolean(KEY_OVERLAY, true).apply();
        try {
            activity.startForegroundService(new Intent(activity, FloatingSwitchService.class)
                    .setAction(FloatingSwitchService.ACTION_START));
        } catch (RuntimeException ignored) {
            prefs.edit().putBoolean(KEY_OVERLAY, false).apply();
            toast(R.string.qa_overlay_failed);
        }
    }

    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        if (destroyed) return;
        boolean granted = grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED;
        if (requestCode == REQUEST_OVERLAY_NOTIFICATION && awaitingOverlayNotification) {
            awaitingOverlayNotification = false;
            if (granted) requestOverlayNotificationThenStart();
            else toast(R.string.qa_notification_permission);
        } else if (requestCode == REQUEST_NOTIFICATION && awaitingNotification) {
            awaitingNotification = false;
            if (granted) setNotificationEnabled(true);
            else {
                prefs.edit().putBoolean(KEY_NOTIFICATION, false).apply();
                toast(R.string.qa_notification_permission);
            }
        } else return;
        refresh();
    }

    public void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (destroyed || requestCode != REQUEST_OVERLAY || !awaitingOverlay) return;
        awaitingOverlay = false;
        if (Settings.canDrawOverlays(activity)) requestOverlayNotificationThenStart();
        else toast(R.string.qa_overlay_denied);
        syncControls();
    }

    /** Detaches Activity UI only. A user-enabled foreground overlay outlives the Activity. */
    public void destroy() {
        destroyed = true;
        awaitingOverlay = false;
        awaitingNotification = false;
        awaitingOverlayNotification = false;
        prefs.unregisterOnSharedPreferenceChangeListener(preferenceListener);
        if (settings != null) settings.dismiss();
    }

    private void syncControls() {
        syncing = true;
        if (notificationSwitch != null) notificationSwitch.setChecked(prefs.getBoolean(KEY_NOTIFICATION, false));
        if (overlaySwitch != null) overlaySwitch.setChecked(prefs.getBoolean(KEY_OVERLAY, false)
                && Settings.canDrawOverlays(activity));
        syncing = false;
    }

    private void showNotification(List<Account> accounts) {
        NotificationManager manager = activity.getSystemService(NotificationManager.class);
        if (manager == null) return;
        manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID,
                activity.getString(R.string.qa_notification_channel), NotificationManager.IMPORTANCE_LOW));
        NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
        if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return;
        PendingIntent picker = PendingIntent.getActivity(activity, 7401,
                pickerIntent(activity), PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Notification.Builder builder = new Notification.Builder(activity, CHANNEL_ID)
                .setSmallIcon(R.drawable.qa_ic_switch)
                .setContentTitle(activity.getString(R.string.qa_notification_title))
                .setContentText(activity.getString(R.string.qa_notification_text))
                .setContentIntent(picker).setOngoing(true).setOnlyAlertOnce(true)
                .setVisibility(Notification.VISIBILITY_SECRET);
        // Unique data in each explicit Activity intent prevents account action collisions.
        for (int i = 0; i < Math.min(2, accounts.size()); i++) {
            Account account = accounts.get(i);
            PendingIntent select = PendingIntent.getActivity(activity, 0,
                    AccountShortcuts.switchIntent(activity, account.id),
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            builder.addAction(new Notification.Action.Builder(null,
                    AccountShortcuts.displayName(activity, account), select).build());
        }
        Intent stop = new Intent(activity, StopNotificationReceiver.class).setAction(ACTION_STOP_NOTIFICATION);
        PendingIntent stopAction = PendingIntent.getBroadcast(activity, 7405, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        builder.addAction(new Notification.Action.Builder(null,
                activity.getString(R.string.qa_stop_notification), stopAction).build());
        try { manager.notify(NOTIFICATION_ID, builder.build()); }
        catch (SecurityException ignored) { prefs.edit().putBoolean(KEY_NOTIFICATION, false).apply(); }
    }

    static Intent pickerIntent(Context context) {
        return new Intent(context, AccountPickerActivity.class)
                .setAction("com.seekstars.muselauncher.action.PICK_ACCOUNT")
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
    }

    static boolean notificationsAllowed(Context context, String channelId) {
        if (Build.VERSION.SDK_INT >= 33 && context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS)
                != PackageManager.PERMISSION_GRANTED) return false;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager == null || !manager.areNotificationsEnabled()) return false;
        NotificationChannel channel = manager.getNotificationChannel(channelId);
        return channel == null || channel.getImportance() != NotificationManager.IMPORTANCE_NONE;
    }

    private void showNotificationSettings(String channelId) {
        toast(R.string.qa_notification_blocked);
        NotificationManager manager = activity.getSystemService(NotificationManager.class);
        boolean channelBlocked = manager != null && manager.areNotificationsEnabled()
                && manager.getNotificationChannel(channelId) != null;
        Intent intent = new Intent(channelBlocked ? Settings.ACTION_CHANNEL_NOTIFICATION_SETTINGS
                : Settings.ACTION_APP_NOTIFICATION_SETTINGS)
                .putExtra(Settings.EXTRA_APP_PACKAGE, activity.getPackageName());
        if (channelBlocked) intent.putExtra(Settings.EXTRA_CHANNEL_ID, channelId);
        try { activity.startActivity(intent); }
        catch (RuntimeException ignored) { }
    }

    private static void cancelNotification(Context context) {
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        if (manager != null) manager.cancel(NOTIFICATION_ID);
    }

    private void toast(int message) {
        Toast.makeText(activity, message, Toast.LENGTH_LONG).show();
    }

    /** Manifest-registered non-exported receiver allows opt-out without opening an Activity. */
    public static class StopNotificationReceiver extends BroadcastReceiver {
        @Override public void onReceive(Context context, Intent intent) {
            if (intent != null && ACTION_STOP_NOTIFICATION.equals(intent.getAction())) {
                preferences(context).edit().putBoolean(KEY_NOTIFICATION, false).apply();
                cancelNotification(context);
            }
        }
    }
}
