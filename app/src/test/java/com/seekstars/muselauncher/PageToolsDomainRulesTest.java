package com.seekstars.muselauncher;

import org.junit.Test;
import static org.junit.Assert.*;

public class PageToolsDomainRulesTest {
    @Test public void blocksExactAndSubdomainButNotSuffixLookalikes() {
        DomainRules rules = DomainRules.parse(true, "ads.example.com", "");
        assertTrue(rules.shouldBlock("https://ads.example.com/a", false));
        assertTrue(rules.shouldBlock("https://img.ads.example.com/a", false));
        assertFalse(rules.shouldBlock("https://badads.example.com/a", false));
        assertFalse(rules.shouldBlock("https://ads.example.com.evil.test/a", false));
        assertTrue(rules.shouldBlock("https://ADS.EXAMPLE.COM.:443/a", false));
    }
    @Test public void allowRulesWinEvenAgainstMoreSpecificBlock() {
        DomainRules rules = DomainRules.parse(true, "ads.example.com", "example.com");
        assertFalse(rules.shouldBlock("https://ads.example.com/a", false));
    }
    @Test public void disabledAndMainFrameAreAlwaysAllowed() {
        assertFalse(DomainRules.parse(false, "ads.example.com", "").shouldBlock("https://ads.example.com", false));
        assertFalse(DomainRules.parse(true, "ads.example.com", "").shouldBlock("https://ads.example.com", true));
    }
    @Test public void hostsLinesNormalizeCommentsAndMultipleHosts() {
        DomainRules rules = DomainRules.parse(true,
                "# sample\n0.0.0.0 Ads.Example.com stats.example.com # both\n::1 tracker.example.com\n例子.测试", "");
        assertTrue(rules.shouldBlock("https://stats.example.com/a", false));
        assertTrue(rules.shouldBlock("https://tracker.example.com/a", false));
        assertTrue(rules.shouldBlock("https://xn--fsqu00a.xn--0zwm56d/a", false));
    }
    @Test public void rejectsInvalidRulesInsteadOfSilentlyChangingMeaning() {
        for (String bad : new String[]{"https://example.com", "*.example.com", "example.com/path", "a..com", "-a.com", "a.com:443", "one.example two.example", "999.1.1.1 a.example"}) {
            assertThrows(bad, IllegalArgumentException.class, () -> DomainRules.parse(true, bad, ""));
        }
    }
    @Test public void malformedAndNonHttpRequestsPassThrough() {
        DomainRules rules = DomainRules.parse(true, "ads.example.com", "");
        for (String bad : new String[]{null, "", "https:///ads.example.com", "data:text/plain,ads.example.com", "https://ads.example.com\\@good.example/a"}) {
            assertFalse(rules.shouldBlock(bad, false));
        }
    }
}
