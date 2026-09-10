package com.mattmc.mcptoolkit.ui.sample.menu;

import com.mattmc.mcptoolkit.ui.GeneratedScreens;
import com.mattmc.mcptoolkit.ui.doc.Element;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.world.Container;
import net.minecraft.world.SimpleContainer;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.flag.FeatureFlags;
import net.minecraft.world.inventory.MenuType;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import org.jspecify.annotations.Nullable;

/**
 * The hand-written half of the Example menu (SCREEN_AUTHORING_DESIGN.md section 7):
 * what the actions DO and what supplies the bindings. Generated ONCE as a stub and never
 * overwritten - this file is yours.
 *
 * <p>This is the toolkit's sample, so "what supplies the bindings" is the document itself: the
 * server-side menu answers every binding from its {@code preview} value and fills its container
 * from the slots' placeholders, which is exactly what the detached interpreter shows. The two
 * renderers therefore start from the same state, and a pixel difference between them is a
 * difference in RENDERING, which is the only kind section 12 wants to see. Actions are recorded in
 * {@link GeneratedScreens#recordAction} so a probe can prove the button channel end to end.
 *
 * Register the menu type from your mod initializer:
 *   Registry.register(BuiltInRegistries.MENU, Identifier.fromNamespaceAndPath("mcptoolkit", "example"), ExampleMenu.TYPE);  // in your ModInitializer
 */
public class ExampleMenu extends ExampleMenuBase {
    public static final MenuType<ExampleMenu> TYPE = new MenuType<>(ExampleMenu::new, FeatureFlags.DEFAULT_FLAGS);

    /** The document the server-side menu answers from; {@code null} on the client, where values arrive synced. */
    private final @Nullable UiDocument doc;

    /**
     * The client-side constructor the menu type calls: the containers are stand-ins the server syncs into.
     */
    public ExampleMenu(final int containerId, final Inventory playerInventory) {
        this(containerId, playerInventory, new SimpleContainer(INPUT_SIZE), null);
    }

    /**
     * The server-side constructor: hand it the real containers.
     */
    public ExampleMenu(final int containerId, final Inventory playerInventory, final Container inputContainer,
                       final @Nullable UiDocument doc) {
        super(TYPE, containerId, playerInventory, inputContainer);
        this.doc = doc;
    }

    /** A server-side menu over the document's own placeholders and previews - the sample's "real" state. */
    public static ExampleMenu forDocument(final int containerId, final Inventory playerInventory, final UiDocument doc) {
        SimpleContainer input = new SimpleContainer(INPUT_SIZE);
        for (Element e : doc.flatten()) {
            if (e instanceof Element.Slot s && "input".equals(s.container()) && s.placeholder() != null) {
                Identifier id = Identifier.tryParse(s.placeholder().item());
                Item item = id == null ? null : BuiltInRegistries.ITEM.getOptional(id).orElse(null);
                input.setItem(s.index(), new ItemStack(item == null ? Items.BARRIER : item, s.placeholder().count()));
            }
        }
        return new ExampleMenu(containerId, playerInventory, input, doc);
    }

    private int preview(final String binding) {
        UiDocument.Binding b = doc == null ? null : doc.binding(binding);
        return b == null ? 0 : b.preview();
    }

    @Override
    protected int supplyProgress() {
        return preview("progress");
    }

    @Override
    protected int supplyFuel() {
        return preview("fuel");
    }

    @Override
    protected int supplyFuelMax() {
        return preview("fuel_max");
    }

    @Override
    protected boolean onLaunch(final Player player) {
        GeneratedScreens.recordAction("launch");
        return true;
    }

    @Override
    protected boolean onCancel(final Player player) {
        GeneratedScreens.recordAction("cancel");
        return true;
    }

    /**
     * The parameterised action (UI_PARTS_LIBRARY_DESIGN.md section 4.2): the index arrives DECODED
     * and already bounds-checked, because the base class generated both halves of the packing from
     * the one arity the document declares.
     */
    @Override
    protected boolean onSelect(final Player player, final int index) {
        GeneratedScreens.recordAction("select " + index);
        return true;
    }

    @Override
    public boolean stillValid(final Player player) {
        return true;
    }
}
