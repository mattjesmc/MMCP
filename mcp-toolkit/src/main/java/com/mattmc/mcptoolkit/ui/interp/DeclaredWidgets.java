package com.mattmc.mcptoolkit.ui.interp;

import com.mattmc.mcptoolkit.ui.doc.Element;
import com.mattmc.mcptoolkit.ui.doc.Kind;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.ComponentPath;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.components.ItemDisplayWidget;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.client.gui.navigation.FocusNavigationEvent;
import net.minecraft.client.gui.screens.inventory.InventoryScreen;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.client.renderer.entity.layers.HumanoidArmorLayer;
import net.minecraft.client.renderer.entity.state.ArmorStandRenderState;
import net.minecraft.client.renderer.entity.state.EntityRenderState;
import net.minecraft.client.renderer.entity.state.LivingEntityRenderState;
import net.minecraft.client.renderer.item.ItemModelResolver;
import net.minecraft.client.sounds.SoundManager;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntitySpawnReason;
import net.minecraft.world.entity.EntityType;
import net.minecraft.world.entity.EntityTypes;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.item.ItemDisplayContext;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.equipment.Equippable;
import org.joml.Quaternionf;
import org.joml.Vector3f;
import org.jspecify.annotations.Nullable;

import java.util.List;
import java.util.function.Supplier;

/**
 * The vanilla widgets a document element becomes, each tagged with its element so
 * {@code get_screen} can name it ({@link UiDeclared}). Subclasses rather than wrappers: a
 * {@code button} IS a {@code Button}, so {@code click}, the tab order, narration and the annotated
 * screenshot all treat it as one without knowing this project exists.
 *
 * <p>Two 26.2 facts shaped this file: {@code Button} is abstract and its concrete face is
 * {@code Button.Plain} (a protected constructor, so a subclass can reach it), and
 * {@code ImageWidget.Sprite} is private (only the {@code ImageWidget.sprite} factory hands one out),
 * so the icon is its own two-line widget rather than a subclass of vanilla's.
 */
@Environment(EnvType.CLIENT)
public final class DeclaredWidgets {
    private DeclaredWidgets() {}

    /**
     * A vanilla button; with a sprite, the sprite is drawn over the face.
     *
     * <p>With {@code face: none} there IS no face: the sprite is the button, filling its rectangle,
     * swapped for {@code sprite_hovered} under the pointer and drawn at half alpha when inactive.
     * That is the bare arrow off a sheet the parts-library design section 3.4 counted four
     * hand-rolled copies of.
     */
    public static final class DeclaredButton extends Button.Plain implements UiDeclared {
        private final @Nullable String id;
        private final @Nullable Identifier sprite;
        private final @Nullable Identifier spriteHovered;
        private final boolean bare;

        public DeclaredButton(final @Nullable String id, final int x, final int y, final int w, final int h,
                              final Component text, final @Nullable Identifier sprite,
                              final @Nullable Identifier spriteHovered, final boolean bare, final OnPress onPress) {
            super(x, y, w, h, text, onPress, DEFAULT_NARRATION);
            this.id = id;
            this.sprite = sprite;
            this.spriteHovered = spriteHovered;
            this.bare = bare;
        }

        @Override
        public @Nullable String uiId() {
            return id;
        }

        @Override
        public Kind uiKind() {
            return Kind.BUTTON;
        }

        @Override
        protected void extractContents(final GuiGraphicsExtractor graphics, final int mouseX, final int mouseY, final float a) {
            if (!bare) {
                super.extractContents(graphics, mouseX, mouseY, a);
            }
            Identifier drawn = isHovered() && spriteHovered != null ? spriteHovered : sprite;
            if (drawn == null) {
                return;
            }
            int sx;
            int sy;
            int sw;
            int sh;
            if (bare) {
                // No face to sit on: the sprite IS the button.
                sx = getX();
                sy = getY();
                sw = getWidth();
                sh = getHeight();
            } else {
                // A square inset by the face's 2px border on each side, centred: a 20x20 button
                // shows a 16x16 sprite, vanilla's icon size.
                int size = Math.max(1, Math.min(getWidth(), getHeight()) - 4);
                sx = getX() + (getWidth() - size) / 2;
                sy = getY() + (getHeight() - size) / 2;
                sw = size;
                sh = size;
            }
            graphics.blitSprite(RenderPipelines.GUI_TEXTURED, drawn, sx, sy, sw, sh, active ? -1 : 0x80FFFFFF);
        }
    }

    /**
     * A GUI-atlas sprite, or a window into a raw texture. Inactive and unfocusable, like vanilla's
     * {@code ImageWidget}.
     *
     * <p>The texture form is ONE vanilla blit with a source rectangle and a destination rectangle,
     * which is scaling, cropping and tinting in a single call - the four-line
     * {@code pushMatrix()/scale(0.5f)} block section 3.4 found written out by hand every time.
     */
    public static final class DeclaredIcon extends AbstractWidget implements UiDeclared {
        private final @Nullable String id;
        private final @Nullable Identifier sprite;
        private final @Nullable Identifier texture;
        private final int u;
        private final int v;
        private final int srcW;
        private final int srcH;
        private final int sheetW;
        private final int sheetH;
        private final int color;

        public DeclaredIcon(final @Nullable String id, final int x, final int y, final int w, final int h,
                            final @Nullable Identifier sprite, final @Nullable Identifier texture,
                            final int u, final int v, final int srcW, final int srcH,
                            final int sheetW, final int sheetH, final int color) {
            super(x, y, w, h, Component.empty()); // the id rides UiDeclared, not the label
            this.id = id;
            this.sprite = sprite;
            this.texture = texture;
            this.u = u;
            this.v = v;
            this.srcW = srcW;
            this.srcH = srcH;
            this.sheetW = sheetW;
            this.sheetH = sheetH;
            this.color = color;
            this.active = false;
        }

        @Override
        public @Nullable String uiId() {
            return id;
        }

        @Override
        public Kind uiKind() {
            return Kind.ICON;
        }

        @Override
        protected void extractWidgetRenderState(final GuiGraphicsExtractor graphics, final int mouseX, final int mouseY, final float a) {
            if (sprite != null) {
                graphics.blitSprite(RenderPipelines.GUI_TEXTURED, sprite, getX(), getY(), getWidth(), getHeight(), color);
            } else if (texture != null) {
                graphics.blit(RenderPipelines.GUI_TEXTURED, texture, getX(), getY(), u, v,
                    getWidth(), getHeight(), srcW, srcH, sheetW, sheetH, color);
            }
        }

        @Override
        protected void updateWidgetNarration(final NarrationElementOutput output) {
            // An icon narrates nothing.
        }

        @Override
        public @Nullable ComponentPath nextFocusPath(final FocusNavigationEvent navigationEvent) {
            return null;
        }

        @Override
        public void playDownSound(final SoundManager soundManager) {
            // Silent.
        }
    }

    /**
     * <b>A live entity in a rectangle</b> (the parts-library design section 3.1, the single biggest
     * omission it found).
     *
     * <p>{@code GuiGraphicsExtractor.entity} is one call; what surrounds it is twenty lines that are
     * identical in the inventory, the smithing table and every mob-preview screen - building a render
     * state, driving the right renderer, the two rotations, the drag. That is the definition of
     * something that belongs in the vocabulary rather than in a hook, and this is it.
     *
     * <p>Three subjects: the client {@code player}, an {@code armor_stand} that wears what named
     * slots hold, and any entity type id, created client-side once and never added to a level.
     */
    public static final class DeclaredEntity extends AbstractWidget implements UiDeclared {
        /** Vanilla's own inventory offset: it lifts the subject so its feet sit on the bottom edge. */
        private static final float FOOT_OFFSET = 0.0625F;
        /** An armour stand's real hitbox, so the translation below centres it as vanilla does. */
        private static final float STAND_WIDTH = 0.5F;
        private static final float STAND_HEIGHT = 1.975F;

        private final @Nullable String id;
        private final String subject;
        private final float scale;
        private final float pitch;
        private final float yaw;
        private final boolean followMouse;
        private final Supplier<List<ItemStack>> equipment;
        private final ArmorStandRenderState stand = new ArmorStandRenderState();
        private @Nullable Entity created;
        private boolean createTried;
        private float dragYaw;

        public DeclaredEntity(final @Nullable String id, final int x, final int y, final int w, final int h,
                              final String subject, final float scale, final float pitch, final float yaw,
                              final boolean followMouse, final boolean draggable,
                              final Supplier<List<ItemStack>> equipment) {
            super(x, y, w, h, Component.empty());
            this.id = id;
            this.subject = subject;
            this.scale = scale;
            this.pitch = pitch;
            this.yaw = yaw;
            this.followMouse = followMouse;
            this.equipment = equipment;
            // Active ONLY when it can be turned: an inactive widget takes no click, so a preview
            // never steals one from the slot behind it.
            this.active = draggable;
            this.stand.entityType = EntityTypes.ARMOR_STAND;
            this.stand.showBasePlate = false;
            this.stand.showArms = true;
            this.stand.boundingBoxWidth = STAND_WIDTH;
            this.stand.boundingBoxHeight = STAND_HEIGHT;
        }

        @Override
        public @Nullable String uiId() {
            return id;
        }

        @Override
        public Kind uiKind() {
            return Kind.ENTITY;
        }

        @Override
        protected void onDrag(final MouseButtonEvent event, final double dx, final double dy) {
            dragYaw += (float) dx;
        }

        @Override
        protected void extractWidgetRenderState(final GuiGraphicsExtractor graphics, final int mouseX, final int mouseY, final float a) {
            Minecraft mc = Minecraft.getInstance();
            int x0 = getX();
            int y0 = getY();
            int x1 = x0 + getWidth();
            int y1 = y0 + getHeight();
            LivingEntity live = livingSubject(mc);
            if (live != null && followMouse && dragYaw == 0.0F) {
                // Vanilla's own helper, verbatim: the inventory's subject looks at the pointer, and
                // reimplementing that is how two screens come to breathe at different rates.
                InventoryScreen.extractEntityInInventoryFollowsMouse(graphics, x0, y0, x1, y1,
                    (int) scale, FOOT_OFFSET, mouseX, mouseY, live);
                return;
            }
            EntityRenderState state = renderState(mc, live);
            if (state == null) {
                return;
            }
            float turn = yaw + dragYaw;
            if (state instanceof LivingEntityRenderState living) {
                living.bodyRot = 180.0F + turn;
                living.yRot = turn;
                living.xRot = pitch;
            }
            Quaternionf rotation = new Quaternionf()
                .rotationXYZ(pitch * ((float) Math.PI / 180.0F), 0.0F, (float) Math.PI);
            Vector3f translation = new Vector3f(0.0F, state.boundingBoxHeight / 2.0F + FOOT_OFFSET, 0.0F);
            graphics.entity(state, scale, translation, rotation, null, x0, y0, x1, y1);
        }

        /** The subject as a living entity, when there is one: the player, or a created mob. */
        private @Nullable LivingEntity livingSubject(final Minecraft mc) {
            if ("player".equals(subject)) {
                return mc.player;
            }
            if ("armor_stand".equals(subject)) {
                return null;
            }
            return subjectEntity(mc) instanceof LivingEntity living ? living : null;
        }

        /** The render state to draw: the armour stand's own, or the dispatcher's for a real entity. */
        private @Nullable EntityRenderState renderState(final Minecraft mc, final @Nullable LivingEntity live) {
            if ("armor_stand".equals(subject)) {
                equip();
                return stand;
            }
            Entity entity = live != null ? live : subjectEntity(mc);
            if (entity == null) {
                return null;
            }
            EntityRenderState state = mc.getEntityRenderDispatcher().getRenderer(entity).createRenderState(entity, 1.0F);
            state.shadowPieces.clear();
            state.shadowRadius = 0.0F;
            return state;
        }

        /**
         * The entity behind an entity-type subject: created once against the client level and never
         * added to it, so it ticks nothing and nobody can see it but this rectangle.
         */
        private @Nullable Entity subjectEntity(final Minecraft mc) {
            if (createTried || mc.level == null) {
                return created;
            }
            createTried = true;
            Identifier rl = Identifier.tryParse(subject);
            EntityType<?> type = rl == null ? null : BuiltInRegistries.ENTITY_TYPE.getOptional(rl).orElse(null);
            created = type == null ? null : type.create(mc.level, EntitySpawnReason.LOAD);
            return created;
        }

        /**
         * Dress the armour stand in whatever the named slots hold - vanilla's own routing, which is
         * what a screen that shows an armour SET is for.
         */
        private void equip() {
            stand.headEquipment = ItemStack.EMPTY;
            stand.chestEquipment = ItemStack.EMPTY;
            stand.legsEquipment = ItemStack.EMPTY;
            stand.feetEquipment = ItemStack.EMPTY;
            stand.leftHandItemStack = ItemStack.EMPTY;
            stand.leftHandItemState.clear();
            stand.headItem.clear();
            ItemModelResolver resolver = Minecraft.getInstance().getItemModelResolver();
            for (ItemStack stack : equipment.get()) {
                if (stack.isEmpty()) {
                    continue;
                }
                Equippable equippable = stack.get(DataComponents.EQUIPPABLE);
                EquipmentSlot slot = equippable == null ? null : equippable.slot();
                if (slot == EquipmentSlot.HEAD) {
                    if (HumanoidArmorLayer.shouldRender(stack, EquipmentSlot.HEAD)) {
                        stand.headEquipment = stack.copy();
                    } else {
                        resolver.updateForTopItem(stand.headItem, stack, ItemDisplayContext.HEAD, null, null, 0);
                    }
                } else if (slot == EquipmentSlot.CHEST) {
                    stand.chestEquipment = stack.copy();
                } else if (slot == EquipmentSlot.LEGS) {
                    stand.legsEquipment = stack.copy();
                } else if (slot == EquipmentSlot.FEET) {
                    stand.feetEquipment = stack.copy();
                } else {
                    stand.leftHandItemStack = stack.copy();
                    resolver.updateForTopItem(stand.leftHandItemState, stack,
                        ItemDisplayContext.THIRD_PERSON_LEFT_HAND, null, null, 0);
                }
            }
        }

        @Override
        protected void updateWidgetNarration(final NarrationElementOutput output) {
            // A preview narrates nothing.
        }

        @Override
        public @Nullable ComponentPath nextFocusPath(final FocusNavigationEvent navigationEvent) {
            return null;
        }

        @Override
        public void playDownSound(final SoundManager soundManager) {
            // Silent: turning a preview is not pressing anything.
        }
    }

    /** A static item display, tooltip on hover. */
    public static final class DeclaredItem extends ItemDisplayWidget implements UiDeclared {
        private final @Nullable String id;

        public DeclaredItem(final @Nullable String id, final int x, final int y, final ItemStack stack, final boolean decorated) {
            super(Minecraft.getInstance(), 0, 0, 16, 16, Component.empty(), stack, decorated, true);
            this.id = id;
            setX(x);
            setY(y);
        }

        @Override
        public @Nullable String uiId() {
            return id;
        }

        @Override
        public Kind uiKind() {
            return Kind.ITEM;
        }
    }
}
