package com.mattmc.mcptoolkit.ui.interp;

import com.mattmc.mcptoolkit.McpToolkit;
import com.mattmc.mcptoolkit.ui.doc.Element;
import com.mattmc.mcptoolkit.ui.doc.Element.Placement;
import com.mattmc.mcptoolkit.ui.doc.Kind;
import com.mattmc.mcptoolkit.ui.doc.Text;
import com.mattmc.mcptoolkit.ui.doc.UiDocument;
import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.layouts.FrameLayout;
import net.minecraft.client.gui.layouts.GridLayout;
import net.minecraft.client.gui.layouts.Layout;
import net.minecraft.client.gui.layouts.LayoutElement;
import net.minecraft.client.gui.layouts.LayoutSettings;
import net.minecraft.client.gui.layouts.LinearLayout;
import net.minecraft.client.gui.layouts.SpacerElement;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;
import net.minecraft.world.inventory.AbstractContainerMenu;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;

/**
 * Document elements to widgets, in paint order, for one {@code init()} of an {@link InterpretedScreen}.
 *
 * <p>The {@code switch} over {@link Element} is exhaustive and the sealed hierarchy mirrors
 * {@link Kind}, so a kind added to the registry without a rendering here is a compile error - the
 * "not registered means not renderable" rule of SCREEN_AUTHORING_DESIGN.md section 9, enforced by the
 * compiler rather than by a test that could be deleted.
 *
 * <p>Slots never become widgets: they are the menu's ({@link DetachedMenu} adds them, the screen
 * paints their wells), which is section 4.5 - one declaration, two sides. Layout nodes become a
 * vanilla layout, are arranged once, hand their widgets over, and then leave an inactive
 * {@link DecorWidget} the size of their bounds so {@code get_screen} can name the node and the
 * editor can grab it.
 */
@Environment(EnvType.CLIENT)
final class WidgetBuilder {
    private final UiDocument doc;
    private final Font font;
    private final int left;
    private final int top;
    private final Consumer<AbstractWidget> add;
    private final Map<String, AbstractWidget> byId;
    private final Map<String, int[]> rects;
    private final Consumer<Element.Button> onAction;
    private final UiBindings bindings;
    private final AbstractContainerMenu menu;
    /**
     * What {@code visible} / {@code enabled} mean, one closure per element that declares either.
     *
     * <p>The generated screen keeps the identical list and runs it from {@code containerTick} plus
     * once at the end of {@code init()}; so does this one. Two renderers, one rule.
     */
    private final List<Runnable> states;
    /** The tooltip zones, in document order - the first one under the pointer wins. */
    private final List<Paint.Hover> tooltips;

    /** A layout child that carries an offset, applied after the layout has arranged it. */
    private record Nudge(LayoutElement element, int dx, int dy) {}

    /** A nested layout node, whose bounds are known only once the top-level layout has arranged. */
    private record Node(Element.Layout element, String path, Layout layout) {}

    /**
     * An element whose rectangle can only be read AFTER the top-level layout has arranged and the
     * nudges have been applied - which is every layout child, and the only way a spacer (not a
     * widget at all, so absent from the widget tree) gets a rectangle the editor can grab.
     */
    private record Pending(String path, LayoutElement element) {}

    WidgetBuilder(final UiDocument doc, final Font font, final int left, final int top,
                  final Consumer<AbstractWidget> add, final Map<String, AbstractWidget> byId,
                  final Map<String, int[]> rects, final Consumer<Element.Button> onAction,
                  final UiBindings bindings, final AbstractContainerMenu menu,
                  final List<Runnable> states, final List<Paint.Hover> tooltips) {
        this.doc = doc;
        this.font = font;
        this.left = left;
        this.top = top;
        this.add = add;
        this.byId = byId;
        this.rects = rects;
        this.onAction = onAction;
        this.bindings = bindings;
        this.menu = menu;
        this.states = states;
        this.tooltips = tooltips;
    }

    void buildAll() {
        buildLevel(doc.elements(), "elements");
    }

    /**
     * One level of the tree. A MACRO recurses with the same rules, because what it expanded to is
     * ordinary elements at absolute coordinates - and it leaves behind the union of their rectangles
     * so the editor can grab the instance as one thing (section 5.2 rule 5) even though neither
     * renderer draws anything for it.
     */
    private void buildLevel(final List<Element> elements, final String prefix) {
        for (int index = 0; index < elements.size(); index++) {
            Element e = elements.get(index);
            String path = prefix + "[" + index + "]";
            if (e.kind().isMacro()) {
                buildLevel(e.children(), path + ".children");
                int[] union = null;
                for (int c = 0; c < e.children().size(); c++) {
                    int[] r = rects.get(path + ".children[" + c + "]");
                    if (r == null) {
                        r = slotRect(e.children().get(c));
                    }
                    union = union(union, r);
                }
                if (union != null) {
                    rects.put(path, union);
                }
                continue;
            }
            Placement.Absolute at = (Placement.Absolute) e.placement();
            int x = left + at.x();
            int y = top + at.y();
            if (e instanceof Element.Layout l) {
                nudges.clear();
                nodes.clear();
                pending.clear();
                Layout layout = layoutFor(l, path);
                layout.setX(x);
                layout.setY(y);
                layout.arrangeElements();
                for (Nudge n : nudges) {
                    n.element().visitWidgets(w -> {
                        w.setX(w.getX() + n.dx());
                        w.setY(w.getY() + n.dy());
                    });
                }
                layout.visitWidgets(add);
                // The node widgets: the top-level layout and every nested one, each an inactive
                // rectangle over its arranged bounds. Added AFTER the real widgets so a nested
                // node never sits above the button it contains in the click order. (The first
                // live run named only the top-level node; the nested column/stack/grid were
                // invisible to get_screen.)
                nodeWidget(l, path, layout);
                for (Node n : nodes) {
                    nodeWidget(n.element(), n.path(), n.layout());
                }
                // Rectangles last: a layout child's position is only true after arrangeElements and
                // the nudges above, and the editor's hit test (slice 4) reads these.
                for (Pending p : pending) {
                    rects.put(p.path(), new int[] {p.element().getX(), p.element().getY(),
                        p.element().getWidth(), p.element().getHeight()});
                }
                pending.clear();
            } else if (e.kind().isSlot()) {
                // The menu's. Wells are painted by the screen over the menu's slot list, so a slot
                // the menu does not have is a slot that is not painted - one source of truth.
            } else {
                AbstractWidget w = register(path, e.id(), add(widget(e, x, y)));
                decorate(e, w);
                rects.put(path, new int[] {w.getX(), w.getY(), w.getWidth(), w.getHeight()});
            }
        }
    }

    /** A slot's rectangle, which is the document's rather than any widget's (section 4.5). */
    private int[] slotRect(final Element e) {
        if (e instanceof Element.Slot s) {
            return new int[] {left + s.x() - 1, top + s.y() - 1, 18, 18};
        }
        if (e instanceof Element.SlotGrid g) {
            return new int[] {left + g.x() - 1, top + g.y() - 1, g.cols() * 18, g.rows() * 18};
        }
        return null;
    }

    private static int[] union(final int[] a, final int[] b) {
        if (b == null) {
            return a;
        }
        if (a == null) {
            return b.clone();
        }
        int x0 = Math.min(a[0], b[0]);
        int y0 = Math.min(a[1], b[1]);
        int x1 = Math.max(a[0] + a[2], b[0] + b[2]);
        int y1 = Math.max(a[1] + a[3], b[1] + b[3]);
        return new int[] {x0, y0, x1 - x0, y1 - y0};
    }

    /**
     * The decorations: {@code tooltip}, {@code visible} and {@code enabled} (sections 3.2 and 3.3).
     *
     * <p>Deliberately the same two lists the emitter writes into the generated screen, so what a
     * preview shows is what ships. A HOOK tooltip shows nothing here - and the generated default
     * hook returns no lines either, which is what keeps the pixel comparison honest.
     */
    private void decorate(final Element e, final AbstractWidget w) {
        Element.Decoration deco = e.deco();
        if (deco.isNone()) {
            return;
        }
        if (deco.stateful()) {
            states.add(() -> {
                if (deco.visible() != null) {
                    w.visible = test(deco.visible());
                }
                if (deco.enabled() != null) {
                    w.active = test(deco.enabled());
                }
            });
        }
        Element.Tooltip t = deco.tooltip();
        if (t != null) {
            List<Component> lines = t.isHook() ? List.of() : List.of(component(t.text()));
            tooltips.add(new Paint.Hover(w, () -> lines));
        }
    }

    private boolean test(final Element.Predicate p) {
        return p.test(bindings.bindingValue(p.binding()));
    }

    private final List<Nudge> nudges = new ArrayList<>();
    private final List<Node> nodes = new ArrayList<>();
    private final List<Pending> pending = new ArrayList<>();

    private AbstractWidget add(final AbstractWidget w) {
        add.accept(w);
        return w;
    }

    private void nodeWidget(final Element.Layout l, final String path, final Layout layout) {
        register(path, l.id(), add(new DecorWidget(l.id(), l.kind(), layout.getX(), layout.getY(),
            layout.getWidth(), layout.getHeight(), (g, px, py, pw, ph, mx, my, pt) -> { })));
        rects.put(path, new int[] {layout.getX(), layout.getY(), layout.getWidth(), layout.getHeight()});
    }

    private AbstractWidget register(final String path, final String id, final AbstractWidget w) {
        if (id != null) {
            byId.put(id, w);
        }
        return w;
    }

    // ---------------------------------------------------------------------------------------------

    private Layout layoutFor(final Element.Layout l, final String path) {
        return switch (l.kind()) {
            case ROW -> fillLinear(LinearLayout.horizontal().spacing(l.spacing()), l, path);
            case COLUMN -> fillLinear(LinearLayout.vertical().spacing(l.spacing()), l, path);
            case GRID -> {
                GridLayout grid = new GridLayout().spacing(l.spacing());
                for (int i = 0; i < l.children().size(); i++) {
                    Element child = l.children().get(i);
                    Placement.Cell c = (Placement.Cell) child.placement();
                    LayoutElement le = child(child, path + ".children[" + i + "]");
                    grid.addChild(le, c.row(), c.col(), c.rowSpan(), c.colSpan(), settings(grid.newCellSettings(), c));
                }
                yield grid;
            }
            case STACK -> {
                FrameLayout frame = new FrameLayout();
                for (int i = 0; i < l.children().size(); i++) {
                    Element child = l.children().get(i);
                    Placement.Cell c = (Placement.Cell) child.placement();
                    frame.addChild(child(child, path + ".children[" + i + "]"),
                        settings(frame.newChildLayoutSettings(), c));
                }
                yield frame;
            }
            default -> throw new IllegalStateException("not a layout kind: " + l.kind());
        };
    }

    private Layout fillLinear(final LinearLayout linear, final Element.Layout l, final String path) {
        for (int i = 0; i < l.children().size(); i++) {
            Element child = l.children().get(i);
            Placement.Cell c = (Placement.Cell) child.placement();
            linear.addChild(child(child, path + ".children[" + i + "]"),
                settings(linear.newCellSettings(), c));
        }
        return linear;
    }

    private static LayoutSettings settings(final LayoutSettings s, final Placement.Cell c) {
        Element.Padding p = c.padding();
        if (!p.isNone()) {
            s.padding(p.left(), p.top(), p.right(), p.bottom());
        }
        if (c.alignX() != 0.0F || c.alignY() != 0.0F) {
            s.align(c.alignX(), c.alignY());
        }
        return s;
    }

    /** A layout child: a nested layout, a spacer, or a widget at (0,0) for the layout to place. */
    private LayoutElement child(final Element e, final String path) {
        LayoutElement le;
        if (e instanceof Element.Layout nested) {
            Layout sub = layoutFor(nested, path);
            nodes.add(new Node(nested, path, sub));
            le = sub;
        } else if (e instanceof Element.Spacer s) {
            le = new SpacerElement(s.w(), s.h());
            pending.add(new Pending(path, le));
        } else {
            AbstractWidget w = widget(e, 0, 0);
            register(path, e.id(), w);
            decorate(e, w);
            le = w;
            pending.add(new Pending(path, le));
        }
        Placement.Cell c = (Placement.Cell) e.placement();
        if (c.hasOffset()) {
            nudges.add(new Nudge(le, c.dx(), c.dy()));
        }
        return le;
    }

    // ---------------------------------------------------------------------------------------------

    /** One non-slot, non-layout element as a widget at an absolute position. Exhaustive by construction. */
    private AbstractWidget widget(final Element e, final int x, final int y) {
        return switch (e) {
            case Element.Box b -> new DecorWidget(b.id(), b.kind(), x, y, b.w(), b.h(), switch (b.kind()) {
                case PANEL -> (g, px, py, pw, ph, mx, my, pt) -> Paint.panel(g, px, py, pw, ph);
                case WELL -> (g, px, py, pw, ph, mx, my, pt) -> Paint.well(g, px, py, pw, ph);
                case FRAME -> (g, px, py, pw, ph, mx, my, pt) -> Paint.screenFrame(g, px, py, pw, ph);
                default -> throw new IllegalStateException("not a box kind: " + b.kind());
            });
            case Element.Label l -> new LabelWidget(l.id(), x, y, l.w(), l.h(), component(l.text()), font,
                l.mode(), l.color(), l.shadow());
            case Element.Button b -> new DeclaredWidgets.DeclaredButton(b.id(), x, y, b.w(), b.h(),
                component(b.text()), b.sprite() == null ? null : Identifier.parse(b.sprite()),
                b.spriteHovered() == null ? null : Identifier.parse(b.spriteHovered()),
                b.face() == Element.Face.NONE, btn -> onAction.accept(b));
            case Element.Bar b -> {
                UiDocument.Binding binding = doc.binding(b.binding());
                yield new DecorWidget(b.id(), Kind.BAR, x, y, b.w(), b.h(), (g, px, py, pw, ph, mx, my, pt) -> {
                    float frac = fraction(binding);
                    if (b.vertical()) {
                        Paint.barVertical(g, px, py, pw, ph, frac, b.fill(), b.track());
                    } else {
                        Paint.bar(g, px, py, pw, ph, frac, b.fill(), b.track());
                    }
                });
            }
            case Element.Item i -> new DeclaredWidgets.DeclaredItem(i.id(), x, y, stack(i.item(), i.count()), i.decorated());
            case Element.Icon i -> {
                Element.Sheet sh = i.sheet();
                yield new DeclaredWidgets.DeclaredIcon(i.id(), x, y, i.w(), i.h(),
                    i.sprite() == null ? null : Identifier.parse(i.sprite()),
                    sh == null ? null : Identifier.parse(sh.texture()),
                    sh == null ? 0 : sh.u(), sh == null ? 0 : sh.v(),
                    sh == null ? i.w() : sh.srcW(), sh == null ? i.h() : sh.srcH(),
                    sh == null ? Element.Sheet.DEFAULT_SHEET : sh.sheetW(),
                    sh == null ? Element.Sheet.DEFAULT_SHEET : sh.sheetH(), i.color());
            }
            case Element.Entity en -> new DeclaredWidgets.DeclaredEntity(en.id(), x, y, en.w(), en.h(),
                en.subject().kind(), en.scale(), en.pitch(), en.yaw(), en.followMouse(), en.draggable(),
                () -> equipmentOf(en));
            // The escape hatch paints NOTHING here, on purpose: the generated screen's default hook is
            // empty, and section 12 compares pixels. Showing the rectangle is the editor's overlay.
            case Element.Region r -> new DecorWidget(r.id(), Kind.REGION, x, y, r.w(), r.h(), (g, px, py, pw, ph, mx, my, pt) -> { });
            case Element.Slot s -> throw new IllegalStateException("slots are the menu's, not widgets");
            case Element.SlotGrid s -> throw new IllegalStateException("slots are the menu's, not widgets");
            case Element.Spacer s -> throw new IllegalStateException("a spacer is a layout element, not a widget");
            case Element.Layout l -> throw new IllegalStateException("layouts are built by layoutFor");
            case Element.Part part -> throw new IllegalStateException("a part is expanded, not a widget");
            case Element.Repeat r -> throw new IllegalStateException("a repeat is expanded, not a widget");
        };
    }

    /**
     * What an {@code entity} subject wears: the stacks in the slots it names, read LIVE off the menu.
     *
     * <p>Through the {@link com.mattmc.mcptoolkit.ui.doc.SlotPlan} rather than by counting, which is
     * section 4.5 again: the document's slot element id is the same menu index on both sides.
     */
    private List<ItemStack> equipmentOf(final Element.Entity en) {
        List<ItemStack> out = new ArrayList<>();
        List<com.mattmc.mcptoolkit.ui.doc.SlotPlan.Entry> entries =
            com.mattmc.mcptoolkit.ui.doc.SlotPlan.of(doc).entries();
        for (String slotId : en.subject().equipment()) {
            for (int i = 0; i < entries.size(); i++) {
                if (slotId.equals(entries.get(i).elementId())) {
                    out.add(i < menu.slots.size() ? menu.slots.get(i).getItem() : ItemStack.EMPTY);
                    break;
                }
            }
        }
        return out;
    }

    /** {@code value / max}, with the max resolved through a binding chain and a zero guarded (section 8.2). */
    private float fraction(final UiDocument.Binding binding) {
        if (binding == null) {
            return 0.0F;
        }
        int value = bindings.bindingValue(binding.name());
        int max;
        if (binding.max() != null) {
            max = binding.max();
        } else if (binding.maxBinding() != null) {
            max = bindings.bindingValue(binding.maxBinding());
        } else {
            return 0.0F;
        }
        return max <= 0 ? 0.0F : value / (float) max;
    }

    static Component component(final Text t) {
        return t.isTranslation() ? Component.translatable(t.translate()) : Component.literal(t.literal());
    }

    /** An item stack by id; an unknown id shows a barrier and says so once in the log. */
    static ItemStack stack(final String id, final int count) {
        Identifier rl = Identifier.tryParse(id);
        Item item = rl == null ? null : BuiltInRegistries.ITEM.getOptional(rl).orElse(null);
        if (item == null) {
            McpToolkit.LOGGER.warn("[MCP Toolkit] ui item '{}' is not an item; showing a barrier", id);
            item = Items.BARRIER;
        }
        return new ItemStack(item, count);
    }
}
