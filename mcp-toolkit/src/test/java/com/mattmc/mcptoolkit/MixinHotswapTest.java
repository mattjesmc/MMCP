package com.mattmc.mcptoolkit;

import org.junit.jupiter.api.Test;

import java.net.URL;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The mixin tier's refusals, which are the only part of it a test JVM can reach.
 *
 * <p>Whether Mixin re-applies a reloaded mixin is Mixin's own code and needs a game; what is ours is
 * the account given when it will NOT happen. The failure this guards against is the one the whole
 * finding was about (`docs/platform/HOTSWAP_CEILING.md` section 1): a swap that reports success while
 * the targets keep running the old injector. A game started without the flag can never be armed, so
 * saying so before the swap is the entire contract.
 */
class MixinHotswapTest {

    @Test
    void withoutTheFlagTheAgentIsNotArmedAndTheReasonNamesTheFlag() {
        // The test JVM has no -Dmixin.hotSwap=true, which is exactly a game launched the old way.
        assertFalse(Boolean.parseBoolean(System.getProperty("mixin.hotSwap")));
        assertEquals(MixinHotswap.NEEDS_RESTART, MixinHotswap.arm(null));
        // Idempotent: the state is reached once per JVM and cached, so a second hotswap in the same
        // session does not re-attach anything.
        assertEquals(MixinHotswap.NEEDS_RESTART, MixinHotswap.arm(null));
        assertEquals(MixinHotswap.NEEDS_RESTART, MixinHotswap.state());
    }

    @Test
    void everyUnarmedStateExplainsItselfAsAFix() {
        String restart = MixinHotswap.why(MixinHotswap.NEEDS_RESTART);
        assertNotNull(restart);
        assertTrue(restart.contains("-Dmixin.hotSwap=true"), restart);
        assertTrue(restart.contains("rebuild.ps1"), restart);
        // A relocated or older Mixin: the state carries the throwable, and the message still says
        // what the caller would otherwise discover by watching nothing happen.
        String missing = MixinHotswap.why("unavailable: java.lang.ClassNotFoundException");
        assertNotNull(missing);
        assertTrue(missing.contains("targets untouched"), missing);
    }

    @Test
    void anArmedAgentHasNothingToExplain() {
        assertNull(MixinHotswap.why(MixinHotswap.ARMED));
    }

    @Test
    void theCopyEveryQuestionIsAskedOfIsNeverTheShellIfThereIsAnAlternative() {
        // getAllLoadedClasses has no defined order, so "the first match" is a coin flip between the
        // real class and Mixin's stand-in. A test JVM has no shells to sort behind, so what is pinned
        // here is the contract itself: a non-empty list always answers, an empty one answers null
        // rather than throwing (the caller turns that into "not loaded", which is a different reply).
        assertNull(HotswapTools.primary(List.of()));
        assertEquals(String.class, HotswapTools.primary(List.of(String.class)));
        assertEquals(String.class, HotswapTools.primary(List.of(String.class, Integer.class)));
    }

    @Test
    void theCoveredPrecheckReadsTheSameResourceTheSwapWouldRead() {
        // The live failure this closes: query_class read the CODE SOURCE and a swap read the
        // RESOURCE, and on a mixin shell (no code source, loader still resolves the file) they
        // disagreed - the precheck told callers to pass 'dir' for a swap the default handles.
        URL own = HotswapTools.classpathResource(MixinHotswapTest.class, MixinHotswapTest.class.getName());
        assertNotNull(own);
        assertTrue(own.getPath().endsWith("com/mattmc/mcptoolkit/MixinHotswapTest.class"), own.toString());
        // A name its loader resolves nothing for is null, not an exception: the precheck reports
        // "nowhere to re-read bytes from" and must not take the whole read down to say it.
        assertNull(HotswapTools.classpathResource(MixinHotswapTest.class, "no.such.Class"));
    }

    @Test
    void anOrdinaryClassIsNotAMixinShell() {
        // isAgentShell is how a swap knows it reached the copy that matters. It must not fire on a
        // bootstrap class (null loader) or on an ordinary one, or every swap would claim a re-apply.
        assertFalse(MixinHotswap.isAgentShell(String.class));
        assertFalse(MixinHotswap.isAgentShell(MixinHotswapTest.class));
        assertFalse(MixinHotswap.isAgentShell(int.class));
    }
}
