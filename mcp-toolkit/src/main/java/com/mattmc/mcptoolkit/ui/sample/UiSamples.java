package com.mattmc.mcptoolkit.ui.sample;

import com.mattmc.mcptoolkit.ui.GeneratedScreens;
import com.mattmc.mcptoolkit.ui.sample.menu.ExampleMenu;
import com.mattmc.mcptoolkit.ui.sample.menu.ExampleMenuBase;
import net.minecraft.core.Registry;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.SimpleMenuProvider;

/**
 * The toolkit's own generated screen: {@code assets/mcptoolkit/ui/example.ui.json} compiled by the
 * emitter into {@code ui.sample.menu} / {@code ui.sample.client}, registered the way a mod would
 * register it (the two lines the emitter's report names), and entered in {@link GeneratedScreens}
 * so {@code open_screen {ui:"mcptoolkit:example", generated:true}} can open it.
 *
 * <p>Why the toolkit ships a generated screen of its own: SCREEN_AUTHORING_DESIGN.md section 12
 * compares the interpreter against generated Java, and the example is the one document that uses
 * every registered kind. {@code UiEmitterTest} pins the checked-in machine files to what the
 * emitter produces today, so this sample can never be stale; the probe compares the two screens
 * live.
 *
 * <p>Registration rides the same two windows the body entity types use: {@link #registerTypes()}
 * from {@code BuiltInRegistriesMixin} before the bare-loader freeze, and again from
 * {@link #register()} at init for the fabric-api world where the freeze is delayed. Idempotent.
 */
public final class UiSamples {
    public static final Identifier EXAMPLE_ID = Identifier.fromNamespaceAndPath("mcptoolkit", "example");

    private UiSamples() {}

    public static void registerTypes() {
        if (!BuiltInRegistries.MENU.containsKey(EXAMPLE_ID)) {
            Registry.register(BuiltInRegistries.MENU, EXAMPLE_ID, ExampleMenu.TYPE);
        }
    }

    /** Common init: the menu type (if the mixin did not get there first) and the generated-screen entry. */
    public static void register() {
        registerTypes();
        GeneratedScreens.register(EXAMPLE_ID.toString(),
            doc -> new SimpleMenuProvider((id, inventory, player) -> ExampleMenu.forDocument(id, inventory, doc),
                ExampleMenuBase.TITLE),
            // By name, not ExampleScreen.class: this is common code and a dedicated server has no
            // AbstractContainerScreen to load the class against. The client half is UiSamplesClient.
            "com.mattmc.mcptoolkit.ui.sample.client.ExampleScreen");
    }
}
