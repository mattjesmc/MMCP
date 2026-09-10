package com.mattmc.mcptoolkit.ui.sample.client;

import com.mattmc.mcptoolkit.ui.sample.menu.ExampleMenu;

import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;

import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.player.Inventory;

/**
 * The hand-written half of the Example screen (SCREEN_AUTHORING_DESIGN.md section 7):
 * tooltips, render overrides, and the region hooks (drawRegion_gauge).
 * Generated ONCE as a stub and never overwritten - this file is yours.
 *
 * Register the screen from your client initializer:
 *   MenuScreens.register(ExampleMenu.TYPE, ExampleScreen::new);  // in your ClientModInitializer
 */
@Environment(EnvType.CLIENT)
public class ExampleScreen extends ExampleLayout<ExampleMenu> {
    public ExampleScreen(final ExampleMenu menu, final Inventory inventory, final Component title) {
        super(menu, inventory, title);
    }
}
