package com.mattmc.mcptoolkit;

import com.google.gson.JsonObject;
import org.jspecify.annotations.Nullable;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The re-entry account ({@code HOTSWAP_CEILING.md} §3). What a test JVM can reach is the part that
 * matters most: a swap that lands and changes nothing must SAY so, and every kind of thing a class
 * can be must explain what is still holding old state and what would make the code run again.
 *
 * <p>The screen path is reachable in full here, because the client half is an interface this file
 * can stand in for — which is also why it is an interface. The mob act needs a server and is owed a
 * live confirmation, not a mock: re-running {@code registerGoals()} is Minecraft's code, and a stub
 * that "passed" would be pinning our own stub.
 */
class ReentryTest {

    @AfterEach
    void clearClientSeam() {
        Reentry.setClientForTest(null);
    }

    @Test
    void everyKindSaysWhatStillHoldsOldStateAndWhatWouldReRunIt() {
        for (Reentry.Kind kind : Reentry.Kind.values()) {
            String holds = Reentry.holds(kind);
            assertTrue(holds.length() > 40, kind + " holds: " + holds);
            for (boolean actable : new boolean[] {true, false}) {
                String route = Reentry.route(kind, actable);
                assertTrue(route.length() > 30, kind + " route: " + route);
            }
        }
    }

    @Test
    void onlyTheTwoActableKindsOfferAnActAndOnlyWhenTheGameSaysTheyCan() {
        // The account may not advertise `reinit` where reinit does nothing: that would replace one
        // false belief with another. The two kinds this tool can genuinely re-enter are the two that
        // say so, and each says it ONLY on the live evidence that there is something to re-enter.
        for (Reentry.Kind kind : Reentry.Kind.values()) {
            boolean offersWhenActable = Reentry.route(kind, true).contains("reinit:true");
            boolean offersWhenNot = Reentry.route(kind, false).contains("reinit:true");
            assertEquals(kind == Reentry.Kind.SCREEN || kind == Reentry.Kind.MOB, offersWhenActable,
                kind + " actable route: " + Reentry.route(kind, true));
            assertFalse(offersWhenNot, kind + " inactable route: " + Reentry.route(kind, false));
        }
        // ... and the two that CAN act say something different in the two cases, which is the whole
        // reason live evidence is gathered before the route is written.
        assertNotEquals(Reentry.route(Reentry.Kind.SCREEN, true), Reentry.route(Reentry.Kind.SCREEN, false));
        assertNotEquals(Reentry.route(Reentry.Kind.MOB, true), Reentry.route(Reentry.Kind.MOB, false));
    }

    @Test
    void theRuleNamesTheTwoThingsARedefineDoesNotDo() {
        // The finding in one sentence. A reply that only said "redefined: 1" is what produced the
        // false belief; this is the sentence that has to be in every reply instead.
        assertTrue(Reentry.RULE.contains("Static initialisers do not re-run"), Reentry.RULE);
        assertTrue(Reentry.RULE.contains("constructors do not re-run"), Reentry.RULE);
    }

    @Test
    void aScreenTheClientIsNotOnIsToldToBeOpenedRatherThanOfferedAnAct() {
        Reentry.setClientForTest(new FakeClient(null, "unused"));
        JsonObject entry = onlyClass(Reentry.block(one("com.example.MyScreen"), null, false));
        assertEquals("screen", entry.get("kind").getAsString());
        assertEquals("the client is NOT on this screen", entry.get("live").getAsString());
        assertTrue(entry.get("route").getAsString().contains("open it"), entry.toString());
        assertFalse(entry.get("route").getAsString().contains("reinit:true"), entry.toString());
    }

    @Test
    void theScreenTheClientIsOnIsReEnteredAndTheReplySaysWhatHappened() {
        Reentry.setClientForTest(new FakeClient("com.example.MyScreen", "re-ran init() on the live MyScreen"));
        JsonObject block = Reentry.block(one("com.example.MyScreen"), null, true);
        JsonObject entry = onlyClass(block);
        assertTrue(entry.get("live").getAsString().startsWith("the client is on this screen right now"),
            entry.toString());
        assertEquals("re-ran init() on the live MyScreen", entry.get("reentered").getAsString());
        // Something was re-entered, so there is no "nothing to do" note to pay for.
        assertFalse(block.has("reinit_note"), block.toString());
    }

    @Test
    void aClientThatDoesNotAnswerIsNotReportedAsAClientOnAnotherScreen() {
        // The two facts are different and only one of them is a reason to stop looking. A hung
        // render thread reporting "you are not on this screen" would send a caller to re-open a
        // screen they are already looking at.
        Reentry.setClientForTest(new FakeClient(Reentry.ClientReentry.UNKNOWN, "unused"));
        JsonObject entry = onlyClass(Reentry.block(one("com.example.MyScreen"), null, false));
        assertTrue(entry.get("live").getAsString().contains("unknown"), entry.toString());
        assertFalse(entry.get("route").getAsString().contains("reinit:true"), entry.toString());
    }

    @Test
    void reinitWithNothingToReEnterSaysSoInsteadOfReportingSuccess() {
        // The exact shape of the defect, one level up: `reinit: true` that silently did nothing
        // would be a second success-flavoured non-event on top of the first.
        Reentry.setClientForTest(new FakeClient(null, "unused"));
        JsonObject block = Reentry.block(one("com.example.MyScreen"), null, true);
        assertTrue(block.get("reinit_note").getAsString().contains("nothing to do"), block.toString());
        assertFalse(onlyClass(block).get("reentered").getAsBoolean());
    }

    @Test
    void anOrdinaryClassIsPlainAndTheAccountStillArrives() {
        // No client installed at all (a dedicated server, or a session before any client seam) must
        // not lose the account - it loses only the one kind that needs a screen to exist.
        Map<String, Class<?>> classes = new LinkedHashMap<>();
        classes.put("java.lang.String", String.class);
        JsonObject entry = onlyClass(Reentry.block(classes, null, false));
        assertEquals("plain", entry.get("kind").getAsString());
        assertFalse(entry.has("live"), entry.toString());
        assertTrue(entry.get("holds").getAsString().contains("static initialiser"), entry.toString());
    }

    private static Map<String, Class<?>> one(final String name) {
        Map<String, Class<?>> classes = new LinkedHashMap<>();
        // Any class will do: the fake client below is what decides this is a screen, exactly as the
        // real one does by asking Screen.class.isAssignableFrom.
        classes.put(name, ReentryTest.class);
        return classes;
    }

    private static JsonObject onlyClass(final JsonObject block) {
        assertTrue(block.get("rule").getAsString().length() > 80, "the rule is the block's point");
        assertEquals(1, block.getAsJsonArray("classes").size());
        return block.getAsJsonArray("classes").get(0).getAsJsonObject();
    }

    /** The client half, stood in for: a screen the client is on, is not on, or will not answer about. */
    private record FakeClient(@Nullable String current, String rebuilt) implements Reentry.ClientReentry {
        @Override
        public boolean isScreen(final Class<?> cls) {
            return true;
        }

        @Override
        public @Nullable String currentScreenIs(final Class<?> cls) {
            return current;
        }

        @Override
        public String rebuildCurrentScreen() {
            return rebuilt;
        }
    }
}
