package com.mattmc.mcptoolkit.ui.sample.client;

import com.mattmc.mcptoolkit.ui.sample.menu.ExampleMenu;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.gui.screens.MenuScreens;

/** The client half of {@link com.mattmc.mcptoolkit.ui.sample.UiSamples}: the screen for the sample's menu type. */
@Environment(EnvType.CLIENT)
public final class UiSamplesClient {
    private UiSamplesClient() {}

    public static void register() {
        MenuScreens.register(ExampleMenu.TYPE, ExampleScreen::new);
    }
}
