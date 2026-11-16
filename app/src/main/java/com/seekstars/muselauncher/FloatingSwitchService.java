package com.seekstars.muselauncher;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.content.res.Configuration;
import android.graphics.Insets;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.hardware.display.DisplayManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.provider.Settings;
import android.util.DisplayMetrics;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.WindowMetrics;
import android.widget.ImageButton;
import android.widget.Toast;

/** Explicitly started, non-sticky foreground overlay; never registered for boot. */
public class FloatingSwitchService extends Service {
    public static final String ACTION_START = "com.seekstars.muselauncher.action.START_FLOATING_SWITCH";
    public static final String ACTION_STOP = "com.seekstars.muselauncher.action.STOP_FLOATING_SWITCH";
    public static final String CHANNEL_ID = "muse_quick_access_overlay";
    private static final int NOTIFICATION_ID = 7402;
    private static boolean running;

    static boolean isRunning() { return running; }

    private WindowManager windowManager;
    private DisplayManager displayManager;
    private ImageButton button;
    private WindowManager.LayoutParams params;
    private final Rect available = new Rect();
    private boolean attached;
    private float downX;
    private float downY;
    private int downLeft;
    private int downTop;
    private boolean moved;
    private int touchSlop;
    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        @Override public void onDisplayAdded(int id) { }
        @Override public void onDisplayRemoved(int id) { }
        @Override public void onDisplayChanged(int id) { reposition(); }
    };

    @Override public void onCreate() {
        super.onCreate();
        running = true;
        windowManager = getSystemService(WindowManager.class);
        displayManager = getSystemService(DisplayManager.class);
        touchSlop = ViewConfiguration.get(this).getScaledTouchSlop();
        if (displayManager != null) displayManager.registerDisplayListener(displayListener,
                new Handler(Looper.getMainLooper()));
    }

    @Override public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null || ACTION_STOP.equals(intent.getAction())
                || !ACTION_START.equals(intent.getAction())
                || !QuickAccessController.preferences(this).getBoolean(QuickAccessController.KEY_OVERLAY, false)
                || !Settings.canDrawOverlays(this) || new AccountsStore(this).all().isEmpty()
                || !QuickAccessController.notificationsAllowed(this, CHANNEL_ID)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        try {
            createChannel();
            if (Build.VERSION.SDK_INT >= 34) {
                startForeground(NOTIFICATION_ID, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
            } else {
                startForeground(NOTIFICATION_ID, notification());
            }
            if (!attached) addButton();
            else reposition();
        } catch (RuntimeException ignored) {
            Toast.makeText(this, R.string.qa_overlay_failed, Toast.LENGTH_LONG).show();
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    private void addButton() {
        if (windowManager == null) throw new IllegalStateException("Window manager unavailable");
        button = new ImageButton(this);
        button.setImageResource(R.drawable.qa_ic_switch);
        button.setBackgroundResource(R.drawable.qa_overlay_background);
        button.setPadding(dp(16), dp(16), dp(16), dp(16));
        button.setContentDescription(getString(R.string.qa_overlay_accessibility));
        button.setFocusable(true);
        button.setOnClickListener(v -> openPicker());
        button.setOnTouchListener(this::onTouch);
        params = new WindowManager.LayoutParams(dp(56), dp(56),
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_NOT_TOUCH_MODAL
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        // Absolute LEFT coordinates keep drag math stable in both LTR and RTL locales.
        params.gravity = Gravity.TOP | Gravity.LEFT;
        readBounds();
        float fractionX = QuickAccessController.preferences(this).getFloat("overlay_x", 1f);
        float fractionY = QuickAccessController.preferences(this).getFloat("overlay_y", 0.35f);
        params.x = available.left + Math.round(Math.max(0, available.width() - params.width) * fractionX);
        params.y = available.top + Math.round(Math.max(0, available.height() - params.height) * fractionY);
        clamp();
        windowManager.addView(button, params);
        attached = true;
    }

    private void openPicker() {
        // Direct Activity start from an actual visible-overlay click uses SAW's background-start
        // exemption; a PendingIntent.send() trampoline would lose this on Android 14.
        try { startActivity(QuickAccessController.pickerIntent(this)); }
        catch (RuntimeException ignored) {
            Toast.makeText(this, R.string.qa_entry_failed, Toast.LENGTH_LONG).show();
        }
    }

    private boolean onTouch(View view, MotionEvent event) {
        switch (event.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                downX = event.getRawX(); downY = event.getRawY();
                downLeft = params.x; downTop = params.y; moved = false;
                view.setPressed(true);
                return true;
            case MotionEvent.ACTION_MOVE:
                float dx = event.getRawX() - downX;
                float dy = event.getRawY() - downY;
                moved |= Math.hypot(dx, dy) > touchSlop;
                if (moved) {
                    view.setPressed(false);
                    params.x = downLeft + Math.round(dx);
                    params.y = downTop + Math.round(dy);
                    clamp();
                    updatePosition();
                }
                return true;
            case MotionEvent.ACTION_UP:
                view.setPressed(false);
                if (!moved) view.performClick();
                else savePosition();
                return true;
            case MotionEvent.ACTION_CANCEL:
                view.setPressed(false);
                savePosition();
                return true;
            default: return true;
        }
    }

    private void readBounds() {
        if (Build.VERSION.SDK_INT >= 30 && windowManager != null) {
            WindowMetrics metrics = windowManager.getCurrentWindowMetrics();
            Rect bounds = metrics.getBounds();
            Insets insets = metrics.getWindowInsets().getInsetsIgnoringVisibility(
                    WindowInsets.Type.systemBars() | WindowInsets.Type.displayCutout());
            available.set(insets.left, insets.top,
                    bounds.width() - insets.right, bounds.height() - insets.bottom);
        } else {
            DisplayMetrics metrics = new DisplayMetrics();
            if (windowManager != null) windowManager.getDefaultDisplay().getRealMetrics(metrics);
            else metrics.setTo(getResources().getDisplayMetrics());
            // API 29 fallback conservatively leaves status/navigation-bar space.
            available.set(dp(8), dp(32), Math.max(dp(8), metrics.widthPixels - dp(8)),
                    Math.max(dp(32), metrics.heightPixels - dp(56)));
        }
    }

    private void clamp() {
        if (params == null) return;
        params.x = Math.max(available.left, Math.min(params.x,
                Math.max(available.left, available.right - params.width)));
        params.y = Math.max(available.top, Math.min(params.y,
                Math.max(available.top, available.bottom - params.height)));
    }

    private void reposition() {
        if (!attached || params == null) return;
        if (!Settings.canDrawOverlays(this)
                || !QuickAccessController.notificationsAllowed(this, CHANNEL_ID)) { stopSelf(); return; }
        readBounds();
        clamp();
        updatePosition();
        savePosition();
    }

    private void updatePosition() {
        if (!attached || windowManager == null) return;
        try { windowManager.updateViewLayout(button, params); }
        catch (RuntimeException ignored) { stopSelf(); }
    }

    private void savePosition() {
        if (params == null) return;
        float x = (params.x - available.left) / (float) Math.max(1, available.width() - params.width);
        float y = (params.y - available.top) / (float) Math.max(1, available.height() - params.height);
        QuickAccessController.preferences(this).edit()
                .putFloat("overlay_x", Math.max(0f, Math.min(1f, x)))
                .putFloat("overlay_y", Math.max(0f, Math.min(1f, y))).apply();
    }

    @Override public void onConfigurationChanged(Configuration configuration) {
        super.onConfigurationChanged(configuration);
        reposition();
    }

    @Override public void onDestroy() {
        running = false;
        QuickAccessController.preferences(this).edit()
                .putBoolean(QuickAccessController.KEY_OVERLAY, false).apply();
        if (displayManager != null) displayManager.unregisterDisplayListener(displayListener);
        if (button != null) {
            button.setOnTouchListener(null);
            button.setOnClickListener(null);
            if (attached && windowManager != null) {
                try { windowManager.removeViewImmediate(button); } catch (RuntimeException ignored) { }
            }
            button = null;
        }
        attached = false;
        params = null;
        stopForeground(STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override public IBinder onBind(Intent intent) { return null; }

    private Notification notification() {
        PendingIntent open = PendingIntent.getActivity(this, 7403, QuickAccessController.pickerIntent(this),
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        Intent stop = new Intent(this, FloatingSwitchService.class).setAction(ACTION_STOP);
        PendingIntent stopAction = PendingIntent.getService(this, 7404, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        return new Notification.Builder(this, CHANNEL_ID)
                .setSmallIcon(R.drawable.qa_ic_switch)
                .setContentTitle(getString(R.string.qa_overlay_title))
                .setContentText(getString(R.string.qa_overlay_text))
                .setContentIntent(open).setOngoing(true).setOnlyAlertOnce(true)
                .setVisibility(Notification.VISIBILITY_SECRET)
                .addAction(new Notification.Action.Builder(null,
                        getString(R.string.qa_stop_overlay), stopAction).build())
                .build();
    }

    private void createChannel() {
        NotificationManager manager = getSystemService(NotificationManager.class);
        if (manager != null) manager.createNotificationChannel(new NotificationChannel(
                CHANNEL_ID, getString(R.string.qa_overlay_channel), NotificationManager.IMPORTANCE_LOW));
    }

    private int dp(int value) { return Math.round(value * getResources().getDisplayMetrics().density); }
}
