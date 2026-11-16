package com.seekstars.muselauncher;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotEquals;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.security.GeneralSecurityException;

/** 备份可选加密：往返、前缀容错、篡改与错口令必须报错 */
public class BackupCryptoTest {

    private static final String PASS = "正确的马口令 🐴";

    private static String longText() {
        StringBuilder sb = new StringBuilder(100 * 1024);
        while (sb.length() < 100 * 1024) sb.append("Muse 备份内容 abc😊\n");
        return sb.toString();
    }

    /** 测试里造密文的小工具：把受检异常转成断言失败，保持局部变量 effectively final */
    private static String encOf(String plain) {
        try {
            return BackupCrypto.encrypt(plain, PASS);
        } catch (GeneralSecurityException e) {
            throw new AssertionError(e);
        }
    }

    @Test
    public void roundTrip_ascii() throws Exception {
        String plain = "{\"app\":\"muse-launcher\",\"schema\":1}";
        String enc = BackupCrypto.encrypt(plain, PASS);
        assertTrue(enc.startsWith(BackupCrypto.PREFIX));
        assertEquals(plain, BackupCrypto.decrypt(enc, PASS));
    }

    @Test
    public void roundTrip_unicodeAndEmoji() throws Exception {
        String plain = "账号「干杂活」😊 Proxy=http://1.2.3.4:3129 cookies=hatch_sess=abc";
        assertEquals(plain, BackupCrypto.decrypt(BackupCrypto.encrypt(plain, PASS), PASS));
    }

    /** 100KB 长文本：GCM 单次 update 不会截断，长度必须原样回来 */
    @Test
    public void roundTrip_100kb() throws Exception {
        String plain = longText();
        assertTrue(plain.length() >= 100 * 1024);
        String back = BackupCrypto.decrypt(BackupCrypto.encrypt(plain, PASS), PASS);
        assertEquals(plain.length(), back.length());
        assertEquals(plain, back);
    }

    @Test
    public void roundTrip_emptyPlaintext() throws Exception {
        assertEquals("", BackupCrypto.decrypt(BackupCrypto.encrypt("", PASS), PASS));
        // 空串口令不接受，但空正文明文是可加密的
        assertEquals("", BackupCrypto.decrypt(BackupCrypto.encrypt(null, PASS), PASS));
    }

    /** decrypt 容错：带前缀、不带前缀都要能解 */
    @Test
    public void decrypt_worksWithAndWithoutPrefix() throws Exception {
        String plain = "payload 内容";
        String enc = BackupCrypto.encrypt(plain, PASS);
        assertEquals(plain, BackupCrypto.decrypt(enc, PASS));
        String bare = enc.substring(BackupCrypto.PREFIX.length());
        assertEquals(plain, BackupCrypto.decrypt(bare, PASS));
        // 首尾空白（贴文本时常见的换行）也要能吃
        assertEquals(plain, BackupCrypto.decrypt("  " + enc + "\n", PASS));
    }

    @Test
    public void decrypt_wrongPassphrase_throws() throws Exception {
        String enc = BackupCrypto.encrypt("secret", PASS);
        assertThrows(GeneralSecurityException.class, () -> BackupCrypto.decrypt(enc, "错的"));
    }

    /** 密文改一个字符：GCM tag 校验必须失败，绝不允许返回半截明文 */
    @Test
    public void decrypt_tamperedCiphertext_throws() throws Exception {
        String enc = BackupCrypto.encrypt("secret secret secret", PASS);
        String body = enc.substring(BackupCrypto.PREFIX.length());
        int mid = body.length() / 2;
        char c = body.charAt(mid) == 'A' ? 'B' : 'A';
        String tampered = BackupCrypto.PREFIX
                + body.substring(0, mid) + c + body.substring(mid + 1);
        assertNotEquals(enc, tampered);
        assertThrows(GeneralSecurityException.class, () -> BackupCrypto.decrypt(tampered, PASS));

        // 只动前段（salt/iv 区）也要失败
        String head = BackupCrypto.PREFIX
                + (body.charAt(0) == 'A' ? 'B' : 'A') + body.substring(1);
        assertThrows(GeneralSecurityException.class, () -> BackupCrypto.decrypt(head, PASS));
    }

    @Test
    public void decrypt_garbageBody_throws() {
        // 非法 Base64
        assertThrows(GeneralSecurityException.class,
                () -> BackupCrypto.decrypt(BackupCrypto.PREFIX + "!!!not base64!!!", PASS));
        // 长度够 Base64 但不足 salt+iv+tag
        assertThrows(GeneralSecurityException.class,
                () -> BackupCrypto.decrypt(BackupCrypto.PREFIX + "AAAA", PASS));
        // 只有前缀
        assertThrows(GeneralSecurityException.class,
                () -> BackupCrypto.decrypt(BackupCrypto.PREFIX, PASS));
        // null 密文
        assertThrows(GeneralSecurityException.class, () -> BackupCrypto.decrypt(null, PASS));
    }

    @Test
    public void isEncrypted_trueFalse() throws Exception {
        String enc = BackupCrypto.encrypt("x", PASS);
        assertTrue(BackupCrypto.isEncrypted(enc));
        assertTrue(BackupCrypto.isEncrypted("\n  " + enc + "  "));
        assertTrue(BackupCrypto.isEncrypted(BackupCrypto.PREFIX + "anything"));

        assertFalse(BackupCrypto.isEncrypted(null));
        assertFalse(BackupCrypto.isEncrypted(""));
        assertFalse(BackupCrypto.isEncrypted("{\"app\":\"muse-launcher\"}"));
        assertFalse(BackupCrypto.isEncrypted(enc.substring(BackupCrypto.PREFIX.length())));
    }

    @Test
    public void emptyPassphrase_throwsIllegalArgument() {
        assertThrows(IllegalArgumentException.class, () -> BackupCrypto.encrypt("x", null));
        assertThrows(IllegalArgumentException.class, () -> BackupCrypto.encrypt("x", ""));
        final String enc = encOf("x");
        assertThrows(IllegalArgumentException.class, () -> BackupCrypto.decrypt(enc, null));
        assertThrows(IllegalArgumentException.class, () -> BackupCrypto.decrypt(enc, ""));
    }

    /** 随机 salt + 随机 IV：同样输入两次加密结果必须不同（否则 IV 复用会毁掉 GCM） */
    @Test
    public void encrypt_twice_differentOutput() throws Exception {
        String plain = "同一份备份内容";
        String a = BackupCrypto.encrypt(plain, PASS);
        String b = BackupCrypto.encrypt(plain, PASS);
        assertNotEquals(a, b);
        assertEquals(plain, BackupCrypto.decrypt(a, PASS));
        assertEquals(plain, BackupCrypto.decrypt(b, PASS));
    }
}
