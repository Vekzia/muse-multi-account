package com.seekstars.muselauncher;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * Reconstructs only name/value pairs, not original Cookie attributes.
 * The restore destination is always HTTPS muse.ai with Path=/ and Domain=muse.ai.
 */
final class CookieRestorePolicy {
    private static final int MAX_COOKIE_LEN = 8192;
    private CookieRestorePolicy() { }

    static final class InvalidBackup extends Exception {
        enum Reason { INVALID, DUPLICATE_IDS }
        final Reason reason;
        InvalidBackup(Reason reason) { this.reason = reason; }
    }

    /** Strict import gate: every account entry must be structurally valid and source ids unique. */
    static BackupCodec.Snapshot parseForImport(String text) throws InvalidBackup {
        if (text == null || text.trim().isEmpty()) throw new InvalidBackup(InvalidBackup.Reason.INVALID);
        try {
            JSONObject root = new JSONObject(text);
            if (!BackupCodec.APP.equals(root.optString("app", null))) {
                throw new InvalidBackup(InvalidBackup.Reason.INVALID);
            }
            Object rawSchema = root.opt("schema");
            if (!(rawSchema instanceof Number)) throw new InvalidBackup(InvalidBackup.Reason.INVALID);
            int schema = Integer.parseInt(rawSchema.toString());
            if (schema < 1 || schema > BackupCodec.SCHEMA) {
                throw new InvalidBackup(InvalidBackup.Reason.INVALID);
            }
            JSONArray accounts = root.optJSONArray("accounts");
            if (accounts == null) {
                throw new InvalidBackup(InvalidBackup.Reason.INVALID);
            }
            Set<Long> ids = new HashSet<>();
            for (int i = 0; i < accounts.length(); i++) {
                JSONObject object = accounts.optJSONObject(i);
                if (object == null) throw new InvalidBackup(InvalidBackup.Reason.INVALID);
                Object rawId = object.opt("id");
                Object rawName = object.opt("name");
                if (!(rawId instanceof Number) || !(rawName instanceof String)
                        || Long.parseLong(rawId.toString()) <= 0) {
                    throw new InvalidBackup(InvalidBackup.Reason.INVALID);
                }
                Account account = AccountJsonCodec.readAccount(object);
                if (account.name == null || account.name.trim().isEmpty()) {
                    throw new InvalidBackup(InvalidBackup.Reason.INVALID);
                }
                if (!ids.add(account.id)) {
                    throw new InvalidBackup(InvalidBackup.Reason.DUPLICATE_IDS);
                }
            }
            BackupCodec.Snapshot snapshot = BackupCodec.parse(text);
            if (snapshot == null || snapshot.accounts.size() != accounts.length()) {
                throw new InvalidBackup(InvalidBackup.Reason.INVALID);
            }
            return snapshot;
        } catch (InvalidBackup e) {
            throw e;
        } catch (Exception e) {
            throw new InvalidBackup(InvalidBackup.Reason.INVALID);
        }
    }

    /** Tracks asynchronous setCookie callbacks; duplicate callback delivery is ignored. */
    static final class Results {
        private final List<Long> accountIds;
        private final boolean[] done;
        private final boolean[] accepted;
        private int acceptedCookies;

        Results(List<Long> accountIds) {
            this.accountIds = new ArrayList<>(accountIds);
            this.done = new boolean[accountIds.size()];
            this.accepted = new boolean[accountIds.size()];
        }

        void record(int index, boolean ok) {
            if (index < 0 || index >= done.length || done[index]) return;
            done[index] = true;
            accepted[index] = ok;
            if (ok) acceptedCookies++;
        }

        boolean isComplete() {
            for (boolean value : done) if (!value) return false;
            return true;
        }

        int restoredAccounts() {
            Set<Long> ids = new HashSet<>(accountIds);
            for (int i = 0; i < accountIds.size(); i++) {
                if (!done[i] || !accepted[i]) ids.remove(accountIds.get(i));
            }
            return ids.size();
        }

        int acceptedCookies() { return acceptedCookies; }
    }

    static List<String> toSetCookieLines(String header) {
        if (header == null || header.length() == 0 || header.length() > MAX_COOKIE_LEN) {
            return Collections.emptyList();
        }
        for (int i = 0; i < header.length(); i++) {
            char c = header.charAt(i);
            if (c < 0x20 && c != 0x09) return Collections.emptyList();
            if (c == 0x7f) return Collections.emptyList();
        }
        List<String> lines = new ArrayList<>();
        for (String part : header.split(";")) {
            String pair = part.trim();
            int equals = pair.indexOf('=');
            if (equals <= 0) continue;
            String name = pair.substring(0, equals);
            String value = pair.substring(equals + 1);
            if (!validName(name) || name.startsWith("__Host-") || isAttribute(name)
                    || !validValue(value)) continue;
            // __Host- forbids Domain; __Secure- is compatible with our HTTPS + Secure policy.
            lines.add(name + "=" + value + "; Domain=muse.ai; Path=/; Secure"
                    + ("hatch_sess".equals(name) ? "; HttpOnly" : ""));
        }
        return Collections.unmodifiableList(lines);
    }

    private static boolean isAttribute(String name) {
        return "path".equalsIgnoreCase(name) || "domain".equalsIgnoreCase(name)
                || "max-age".equalsIgnoreCase(name) || "expires".equalsIgnoreCase(name)
                || "secure".equalsIgnoreCase(name) || "httponly".equalsIgnoreCase(name)
                || "samesite".equalsIgnoreCase(name);
    }

    private static boolean validValue(String value) {
        int start = 0;
        int end = value.length();
        if (end >= 2 && value.charAt(0) == 0x22 && value.charAt(end - 1) == 0x22) {
            start++;
            end--;
        }
        for (int i = start; i < end; i++) {
            char c = value.charAt(i);
            // RFC 6265 cookie-octet; quoted values still exclude quotes/backslashes inside.
            if (!(c == 0x21 || (c >= 0x23 && c <= 0x2b) || (c >= 0x2d && c <= 0x3a)
                    || (c >= 0x3c && c <= 0x5b) || (c >= 0x5d && c <= 0x7e))) return false;
        }
        return true;
    }

    private static boolean validName(String name) {
        for (int i = 0; i < name.length(); i++) {
            char c = name.charAt(i);
            if (c <= 0x20 || c >= 0x7f || "()<>@,;:\\\"/[]?={}".indexOf(c) >= 0) return false;
        }
        return !name.isEmpty();
    }
}
