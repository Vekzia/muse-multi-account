package com.seekstars.muselauncher;

import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.SecureRandom;
import java.security.spec.KeySpec;
import java.util.Base64;

import javax.crypto.Cipher;
import javax.crypto.SecretKey;
import javax.crypto.SecretKeyFactory;
import javax.crypto.spec.GCMParameterSpec;
import javax.crypto.spec.PBEKeySpec;
import javax.crypto.spec.SecretKeySpec;

/**
 * 备份文件的可选口令加密（纯 Java 可单元测试）。
 *
 * 为什么用这组参数：
 * - PBKDF2-HMAC-SHA256 + 120000 次迭代：口令是人造的弱秘密，迭代成本是唯一屏障；
 *   120000 在这类中端安卓机上约 0.2~0.5s，用户点一次导出完全能接受。
 * - AES-GCM：备份里放的是代理账号和登录态，既要保密也要防篡改，
 *   AEAD 一个 tag 就把"被改过一个字节"和"口令错"统一成同一个异常。
 * - 每次加密都新取 salt 与 IV：GCM 下 IV 复用会直接毁掉机密性甚至泄露密钥流，
 *   所以绝不允许把 IV 固定成常量或复用同一密钥流。
 *
 * 不引入第三方库（不用 BouncyCastle/Conceal），全部走 JDK / Android 自带 JCE。
 */
final class BackupCrypto {

    /** 密文前缀：既能一眼看出"这份文件要口令"，也让 decrypt 有剥离依据 */
    static final String PREFIX = "MUSEBAK1:";

    private static final String KDF = "PBKDF2WithHmacSHA256";
    private static final String CIPHER = "AES/GCM/NoPadding";
    private static final int ITERATIONS = 120000;
    private static final int SALT_LEN = 16;
    private static final int IV_LEN = 12;
    private static final int TAG_BITS = 128;
    private static final int KEY_BITS = 256;

    /** salt || iv 之后的密文至少要有一个 tag，短于此说明文件被截断 */
    private static final int MIN_BODY = SALT_LEN + IV_LEN + TAG_BITS / 8;

    private BackupCrypto() {
    }

    /** 是否是加密备份；容忍前后空白，方便直接贴文本/读文件时带换行 */
    static boolean isEncrypted(String raw) {
        return raw != null && raw.trim().startsWith(PREFIX);
    }

    /**
     * 加密为 {@code MUSEBAK1:} + Base64(salt||iv||ciphertext+tag)。
     *
     * 用 withoutPadding 是因为 Android 的 SharedPreferences 和各家云盘都对
     * "=" 结尾的文本做额外转义，无填充能少一层坑；decrypt 侧用 MIME/基本解码都能吃。
     *
     * @throws IllegalArgumentException 口令为 null 或空
     * @throws GeneralSecurityException 设备 JCE 异常（算法缺失等）
     */
    static String encrypt(String plaintext, String passphrase) throws GeneralSecurityException {
        requirePassphrase(passphrase);
        byte[] plain = (plaintext == null ? "" : plaintext).getBytes(StandardCharsets.UTF_8);

        byte[] salt = new byte[SALT_LEN];
        byte[] iv = new byte[IV_LEN];
        SecureRandom random = new SecureRandom();
        random.nextBytes(salt);
        random.nextBytes(iv);

        byte[] body = doCrypt(Cipher.ENCRYPT_MODE, plain, passphrase, salt, iv);
        byte[] out = new byte[SALT_LEN + IV_LEN + body.length];
        System.arraycopy(salt, 0, out, 0, SALT_LEN);
        System.arraycopy(iv, 0, out, SALT_LEN, IV_LEN);
        System.arraycopy(body, 0, out, SALT_LEN + IV_LEN, body.length);
        return PREFIX + Base64.getEncoder().withoutPadding().encodeToString(out);
    }

    /**
     * 解密。输入带不带 {@link #PREFIX} 都接受（用户可能手动去掉了前缀或从别处拼回来）。
     *
     * @throws IllegalArgumentException 口令为 null 或空
     * @throws GeneralSecurityException 口令错误 / 密文被篡改 / Base64 或结构损坏
     */
    static String decrypt(String payload, String passphrase) throws GeneralSecurityException {
        requirePassphrase(passphrase);
        if (payload == null) throw new GeneralSecurityException("密文为空");

        String body = payload.trim();
        if (body.startsWith(PREFIX)) body = body.substring(PREFIX.length()).trim();
        if (body.isEmpty()) throw new GeneralSecurityException("密文为空");

        byte[] all;
        try {
            all = Base64.getDecoder().decode(body);
        } catch (IllegalArgumentException e) {
            // Base64 本身坏了就是密文坏了，统一走 GeneralSecurityException，调用方一处 catch
            throw new GeneralSecurityException("密文不是合法 Base64", e);
        }
        if (all.length < MIN_BODY) throw new GeneralSecurityException("密文长度不足");

        byte[] salt = new byte[SALT_LEN];
        byte[] iv = new byte[IV_LEN];
        byte[] ct = new byte[all.length - SALT_LEN - IV_LEN];
        System.arraycopy(all, 0, salt, 0, SALT_LEN);
        System.arraycopy(all, SALT_LEN, iv, 0, IV_LEN);
        System.arraycopy(all, SALT_LEN + IV_LEN, ct, 0, ct.length);

        byte[] plain = doCrypt(Cipher.DECRYPT_MODE, ct, passphrase, salt, iv);
        return new String(plain, StandardCharsets.UTF_8);
    }

    private static byte[] doCrypt(int mode, byte[] input, String passphrase, byte[] salt, byte[] iv)
            throws GeneralSecurityException {
        SecretKey key = deriveKey(passphrase, salt);
        Cipher cipher = Cipher.getInstance(CIPHER);
        cipher.init(mode, key, new GCMParameterSpec(TAG_BITS, iv));
        // 解密时 tag 不匹配会在这里抛 AEADBadTagException（GeneralSecurityException 子类），
        // 不能吞掉转成 null，否则调用方无法区分"口令错"和"文件空"
        return cipher.doFinal(input);
    }

    private static SecretKey deriveKey(String passphrase, byte[] salt) throws GeneralSecurityException {
        char[] chars = passphrase.toCharArray();
        KeySpec spec = new PBEKeySpec(chars, salt, ITERATIONS, KEY_BITS);
        try {
            SecretKeyFactory factory = SecretKeyFactory.getInstance(KDF);
            byte[] raw = factory.generateSecret(spec).getEncoded();
            return new SecretKeySpec(raw, "AES");
        } finally {
            // 口令明文尽快从堆里抹掉；PBEKeySpec 持有的是拷贝，不清就多留一份
            ((PBEKeySpec) spec).clearPassword();
        }
    }

    private static void requirePassphrase(String passphrase) {
        if (passphrase == null || passphrase.isEmpty()) {
            throw new IllegalArgumentException("口令不能为空");
        }
    }
}
