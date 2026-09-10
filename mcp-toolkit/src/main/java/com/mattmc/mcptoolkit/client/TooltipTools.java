package com.mattmc.mcptoolkit.client;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.mattmc.mcptoolkit.ExecutionContext;
import com.mattmc.mcptoolkit.ItemSyntax;
import com.mattmc.mcptoolkit.McpTools;
import com.mattmc.mcptoolkit.Mechanism;
import com.mattmc.mcptoolkit.Schemas;
import com.mattmc.mcptoolkit.ToolDef;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.screens.inventory.AbstractContainerScreen;
import net.minecraft.core.HolderLookup;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.TooltipFlag;

import java.util.List;

/**
 * {@code get_tooltip} - the lines the game would render for a stack, as text (RELEASE_1.md section
 * K2, ArmorPieces' ask 5). A tooltip is the one piece of UI a mod writes that nothing could read
 * back: {@code get_screen} reports a container's slots and {@code click} reaches them, but hovering
 * is not an event the screen exposes, and the consumer's own release notes said its tooltip "was not
 * seen with eyes".
 *
 * <p>The stack comes from item syntax ({@link ItemSyntax}, the parser {@code /give} uses, components
 * included) or from a slot of the open container screen by the index {@code get_screen} reports.
 * The lines are what {@code ItemStack.getTooltipLines} renders with THIS client's player and level
 * - so an enchantment resolves through the level's registries and a mod's tooltip hook runs as it
 * would under the mouse - flattened to strings. Not the styled components: a suite compares text
 * and a session reads text; colour is what {@code render} is for.
 */
@Environment(EnvType.CLIENT)
public final class TooltipTools {

    private TooltipTools() {}

    public static void register() {
        McpTools.register(ToolDef.of(
            "get_tooltip",
            "The tooltip the game would render for an item stack, as text lines. `item` in full item "
                + "syntax (minecraft:diamond_sword[enchantments={\"minecraft:sharpness\":3}], the /give "
                + "form, components included) or `slot`: a container slot index on the OPEN screen, as "
                + "get_screen reports it. `advanced:true` adds the F3+H lines (id, component count). "
                + "Rendered with this client's player and level, so a mod's tooltip hook runs as it would "
                + "under the mouse. Needs the client IN A WORLD: item components are bound when a level's "
                + "registries load, and before that no stack can be made at all (open_world / create_world).",
            Schemas.objectOpt(Schemas.object(
                    "item", Schemas.str("Item syntax: <id>[components]. Count defaults to 1."),
                    "count", Schemas.integer("Stack size for `item` (default 1) - some lines depend on it."),
                    "slot", Schemas.integer("Slot index on the open container screen, from get_screen's menu.slots."),
                    "advanced", Schemas.bool("F3+H lines (default false).")),
                "item", "count", "slot", "advanced"),
            ExecutionContext.CLIENT,
            Mechanism.OBSERVE,
            (ctx, a) -> tooltip(a)));
    }

    private static JsonObject tooltip(final JsonObject a) {
        Minecraft mc = Minecraft.getInstance();
        boolean byItem = a != null && a.has("item") && !a.get("item").isJsonNull();
        boolean bySlot = a != null && a.has("slot") && !a.get("slot").isJsonNull();
        if (byItem == bySlot) {
            throw new IllegalArgumentException("give exactly one of `item` (item syntax) or `slot` (an index from get_screen)");
        }
        // "Components not bound yet": at the title screen the item registry's default components
        // are not bound (that happens when a level's registries load), so ItemParser cannot make a
        // stack from ANY id - measured, not assumed (probes/tooltip.test.mjs, the title-screen arm).
        if (mc.level == null) {
            throw new IllegalStateException("get_tooltip needs the client in a world - item components are "
                + "bound when a level's registries load; open_world or create_world first");
        }
        HolderLookup.Provider registries = mc.level.registryAccess();
        ItemStack stack;
        JsonObject r = new JsonObject();
        if (byItem) {
            int count = a.has("count") && !a.get("count").isJsonNull() ? a.get("count").getAsInt() : 1;
            if (count < 1 || count > 99) {
                throw new IllegalArgumentException("`count` must be 1-99, got " + count);
            }
            stack = ItemSyntax.parse(registries, "item", a.get("item").getAsString(), count);
        } else {
            int index = a.get("slot").getAsInt();
            if (!(mc.gui.screen() instanceof AbstractContainerScreen<?> acs)) {
                throw new IllegalStateException("no container screen is open"
                    + (mc.gui.screen() == null ? "" : " (" + mc.gui.screen().getClass().getSimpleName() + " is)")
                    + "; `slot` needs one - use `item` for a stack that is not on screen");
            }
            AbstractContainerMenu menu = acs.getMenu();
            if (index < 0 || index >= menu.slots.size()) {
                throw new IllegalArgumentException("slot " + index + " is out of range; the open menu has "
                    + menu.slots.size() + " slots");
            }
            stack = menu.slots.get(index).getItem();
            r.addProperty("slot", index);
            if (stack.isEmpty()) {
                r.addProperty("item", "minecraft:air");
                r.addProperty("empty", true);
                r.add("lines", new JsonArray());
                return r;
            }
        }
        boolean advanced = a.has("advanced") && !a.get("advanced").isJsonNull() && a.get("advanced").getAsBoolean();
        Item.TooltipContext context = Item.TooltipContext.of(mc.level);
        List<Component> lines = stack.getTooltipLines(context, mc.player,
            advanced ? TooltipFlag.ADVANCED : TooltipFlag.NORMAL);
        JsonArray out = new JsonArray();
        for (Component line : lines) {
            out.add(line.getString());
        }
        r.addProperty("item", BuiltInRegistries.ITEM.getKey(stack.getItem()).toString());
        r.addProperty("count", stack.getCount());
        r.add("lines", out);
        return r;
    }
}
