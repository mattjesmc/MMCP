package com.mattmc.mcptoolkit.ui.doc;

import com.google.gson.JsonArray;
import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import com.google.gson.JsonPrimitive;
import com.mattmc.mcptoolkit.ui.Palette;
import com.mattmc.mcptoolkit.ui.doc.Element.Placement;
import com.mattmc.mcptoolkit.ui.doc.UiDocument.Binding;
import com.mattmc.mcptoolkit.ui.doc.UiDocument.Container;

import java.util.Map;

/**
 * {@link UiDocument} to JSON, in ONE canonical spelling.
 *
 * <p>Canonical means: keys in a fixed order, defaults omitted, colours as {@code #AARRGGBB}, and a
 * printer that keeps {@code [x, y]} on one line. The editor (slice 4) and the {@code ui_doc} tool
 * (slice 5) both write through here, so a document edited by either produces a diff that is the
 * change and nothing else. {@code parse(write(doc))} equals {@code doc}, and
 * {@code write(parse(write(doc)))} equals {@code write(doc)} - the round trip the slice-1 test pins.
 *
 * <p>Imports Gson only - no Minecraft (section 7.1).
 */
public final class UiWriter {
    private UiWriter() {}

    public static String toJson(final UiDocument doc) {
        return pretty(write(doc)) + "\n";
    }

    public static JsonObject write(final UiDocument doc) {
        JsonObject o = new JsonObject();
        o.addProperty("format", UiDocument.FORMAT);
        o.add("title", text(doc.title()));
        o.addProperty("width", doc.width());
        o.addProperty("height", doc.height());
        if (doc.titleX() != UiDocument.DEFAULT_TITLE_X || doc.titleY() != UiDocument.DEFAULT_TITLE_Y) {
            o.add("title_pos", point(doc.titleX(), doc.titleY()));
        }
        UiDocument.InventoryLabel inv = doc.inventoryLabel();
        if (!inv.shown()) {
            o.addProperty("inventory_label", false);
        } else if (inv.x() != UiDocument.DEFAULT_INVENTORY_LABEL_X
            || inv.y() != UiDocument.defaultInventoryLabelY(doc.height())) {
            o.add("inventory_label", point(inv.x(), inv.y()));
        }
        if (doc.background() != null) {
            o.addProperty("background", doc.background());
        }
        if (doc.sheet() != null) {
            JsonObject so = new JsonObject();
            so.addProperty("texture", doc.sheet().texture());
            if (doc.sheet().width() != doc.width()) {
                so.addProperty("width", doc.sheet().width());
            }
            if (doc.sheet().height() != doc.height()) {
                so.addProperty("height", doc.sheet().height());
            }
            o.add("sheet", so);
        }
        if (!doc.containers().isEmpty()) {
            JsonArray arr = new JsonArray();
            for (Container c : doc.containers()) {
                JsonObject co = new JsonObject();
                co.addProperty("name", c.name());
                co.addProperty("size", c.size());
                arr.add(co);
            }
            o.add("containers", arr);
        }
        if (!doc.actions().isEmpty()) {
            JsonArray arr = new JsonArray();
            for (UiDocument.Action a : doc.actions()) {
                if (!a.parameterised()) {
                    arr.add(a.name());
                    continue;
                }
                JsonObject ao = new JsonObject();
                ao.addProperty("name", a.name());
                JsonArray args = new JsonArray();
                for (int i = 0; i < a.args().size(); i++) {
                    UiDocument.Arg arg = a.args().get(i);
                    if (arg.name().equals(UiDocument.Arg.defaultName(i))) {
                        args.add(arg.size());
                    } else {
                        JsonObject go = new JsonObject();
                        go.addProperty("name", arg.name());
                        go.addProperty("size", arg.size());
                        args.add(go);
                    }
                }
                ao.add("args", args);
                arr.add(ao);
            }
            o.add("actions", arr);
        }
        if (!doc.bindings().isEmpty()) {
            JsonArray arr = new JsonArray();
            for (Binding b : doc.bindings()) {
                JsonObject bo = new JsonObject();
                bo.addProperty("name", b.name());
                if (b.max() != null) {
                    bo.addProperty("max", b.max());
                } else if (b.maxBinding() != null) {
                    bo.addProperty("max", b.maxBinding());
                }
                if (b.wide()) {
                    bo.addProperty("wide", true);
                }
                if (b.preview() != 0) {
                    bo.addProperty("preview", b.preview());
                }
                arr.add(bo);
            }
            o.add("bindings", arr);
        }
        JsonArray els = new JsonArray();
        for (Element e : doc.elements()) {
            els.add(element(e));
        }
        o.add("elements", els);
        return o;
    }

    // ---------------------------------------------------------------------------------------------

    private static JsonObject element(final Element e) {
        JsonObject o = new JsonObject();
        o.addProperty("kind", e.kind().jsonName());
        if (e.id() != null) {
            o.addProperty("id", e.id());
        }
        Placement pl = e.placement();
        if (pl instanceof Placement.Absolute a && e.kind().isMacro()) {
            // A macro's origin is optional: it is an offset applied to a fragment already written
            // around (0,0), and 0,0 is the common case for a repeat.
            if (a.x() != 0) {
                o.addProperty("x", a.x());
            }
            if (a.y() != 0) {
                o.addProperty("y", a.y());
            }
        } else if (pl instanceof Placement.Absolute a) {
            o.addProperty("x", a.x());
            o.addProperty("y", a.y());
        } else if (pl instanceof Placement.Cell c && c.inGrid()) {
            o.addProperty("row", c.row());
            o.addProperty("col", c.col());
            if (c.rowSpan() != 1) {
                o.addProperty("row_span", c.rowSpan());
            }
            if (c.colSpan() != 1) {
                o.addProperty("col_span", c.colSpan());
            }
        }
        switch (e) {
            case Element.Box b -> {
                o.addProperty("w", b.w());
                o.addProperty("h", b.h());
            }
            case Element.Label l -> {
                if (l.w() != 0) {
                    o.addProperty("w", l.w());
                }
                if (l.h() != 0) {
                    o.addProperty("h", l.h());
                }
                o.add("text", text(l.text()));
                if (l.mode() != Element.LabelMode.PLAIN) {
                    o.addProperty("mode", l.mode().jsonName());
                }
                if (l.color() != Palette.LABEL_COLOR) {
                    o.addProperty("color", Colors.format(l.color()));
                }
                if (l.shadow()) {
                    o.addProperty("shadow", true);
                }
            }
            case Element.Slot s -> {
                o.addProperty("container", s.container());
                o.addProperty("index", s.index());
                placeholder(o, s.placeholder());
                if (s.icon() != null) {
                    o.addProperty("icon", s.icon());
                }
            }
            case Element.SlotGrid g -> {
                o.addProperty("cols", g.cols());
                o.addProperty("rows", g.rows());
                o.addProperty("container", g.container());
                if (g.first() != 0) {
                    o.addProperty("first", g.first());
                }
                placeholder(o, g.placeholder());
                if (g.icon() != null) {
                    o.addProperty("icon", g.icon());
                }
            }
            case Element.Button b -> {
                o.addProperty("w", b.w());
                if (b.h() != 20) {
                    o.addProperty("h", b.h());
                }
                o.add("text", text(b.text()));
                o.addProperty("action", b.action());
                if (!b.args().isEmpty()) {
                    JsonArray args = new JsonArray();
                    for (int v : b.args()) {
                        args.add(v);
                    }
                    o.add("args", args);
                }
                if (b.sprite() != null) {
                    o.addProperty("sprite", b.sprite());
                }
                if (b.spriteHovered() != null) {
                    o.addProperty("sprite_hovered", b.spriteHovered());
                }
                if (b.face() != Element.Face.VANILLA) {
                    o.addProperty("face", b.face().jsonName());
                }
            }
            case Element.Bar b -> {
                o.addProperty("w", b.w());
                o.addProperty("h", b.h());
                o.addProperty("binding", b.binding());
                if (b.vertical()) {
                    o.addProperty("orientation", "vertical");
                }
                if (b.fill() != Palette.BAR_FILL) {
                    o.addProperty("fill", Colors.format(b.fill()));
                }
                if (b.track() != Palette.BAR_TRACK) {
                    o.addProperty("track", Colors.format(b.track()));
                }
            }
            case Element.Item i -> {
                o.addProperty("item", i.item());
                if (i.count() != 1) {
                    o.addProperty("count", i.count());
                }
                if (!i.decorated()) {
                    o.addProperty("decorated", false);
                }
            }
            case Element.Icon i -> {
                o.addProperty("w", i.w());
                o.addProperty("h", i.h());
                if (i.sprite() != null) {
                    o.addProperty("sprite", i.sprite());
                }
                if (i.sheet() != null) {
                    Element.Sheet sh = i.sheet();
                    o.addProperty("texture", sh.texture());
                    if (sh.u() != 0) {
                        o.addProperty("u", sh.u());
                    }
                    if (sh.v() != 0) {
                        o.addProperty("v", sh.v());
                    }
                    if (sh.srcW() != i.w()) {
                        o.addProperty("src_w", sh.srcW());
                    }
                    if (sh.srcH() != i.h()) {
                        o.addProperty("src_h", sh.srcH());
                    }
                    if (sh.sheetW() != Element.Sheet.DEFAULT_SHEET) {
                        o.addProperty("sheet_w", sh.sheetW());
                    }
                    if (sh.sheetH() != Element.Sheet.DEFAULT_SHEET) {
                        o.addProperty("sheet_h", sh.sheetH());
                    }
                }
                if (i.color() != -1) {
                    o.addProperty("color", Colors.format(i.color()));
                }
            }
            case Element.Entity en -> {
                o.addProperty("w", en.w());
                o.addProperty("h", en.h());
                o.addProperty("subject", en.subject().kind());
                if (!en.subject().equipment().isEmpty()) {
                    JsonArray eq = new JsonArray();
                    for (String slotId : en.subject().equipment()) {
                        eq.add(slotId);
                    }
                    o.add("equipment", eq);
                }
                if (en.scale() != 25.0F) {
                    o.add("scale", number(en.scale()));
                }
                if (en.pitch() != 0.0F) {
                    o.add("pitch", number(en.pitch()));
                }
                if (en.yaw() != 0.0F) {
                    o.add("yaw", number(en.yaw()));
                }
                if (en.followMouse() != en.subject().isPlayer()) {
                    o.addProperty("follow_mouse", en.followMouse());
                }
                if (en.draggable()) {
                    o.addProperty("draggable", true);
                }
            }
            case Element.Region r -> {
                o.addProperty("w", r.w());
                o.addProperty("h", r.h());
            }
            case Element.Spacer s -> {
                if (s.w() != 0) {
                    o.addProperty("w", s.w());
                }
                if (s.h() != 0) {
                    o.addProperty("h", s.h());
                }
            }
            case Element.Layout l -> {
                if (l.spacing() != 0) {
                    o.addProperty("spacing", l.spacing());
                }
            }
            // A MACRO writes its instance and never its expansion (section 5.2 rule 5): what the
            // human wrote is what a save puts back, or every part in the document would be unpicked
            // into its elements by the first drag.
            case Element.Part part -> {
                o.addProperty("part", part.part());
                for (Element.PartParam prm : part.params()) {
                    JsonElement arg = part.args().get(prm.name());
                    if (arg != null) {
                        o.add(prm.name(), arg);
                    }
                }
            }
            case Element.Repeat r -> o.addProperty("count", r.count());
        }
        Element.Decoration deco = e.deco();
        if (deco.tooltip() != null) {
            o.add("tooltip", tooltip(deco.tooltip()));
        }
        if (deco.visible() != null) {
            o.add("visible", predicate(deco.visible()));
        }
        if (deco.enabled() != null) {
            o.add("enabled", predicate(deco.enabled()));
        }
        if (pl instanceof Placement.Cell c) {
            if (c.hasOffset()) {
                o.add("offset", point(c.dx(), c.dy()));
            }
            if (!c.padding().isNone()) {
                if (c.padding().uniform()) {
                    o.addProperty("padding", c.padding().left());
                } else {
                    JsonArray a = new JsonArray();
                    a.add(c.padding().left());
                    a.add(c.padding().top());
                    a.add(c.padding().right());
                    a.add(c.padding().bottom());
                    o.add("padding", a);
                }
            }
            if (c.alignX() != 0.0F || c.alignY() != 0.0F) {
                JsonArray a = new JsonArray();
                a.add(c.alignX());
                a.add(c.alignY());
                o.add("align", a);
            }
        }
        if (e instanceof Element.Layout l) {
            JsonArray arr = new JsonArray();
            for (Element child : l.children()) {
                arr.add(element(child));
            }
            o.add("children", arr);
        } else if (e instanceof Element.Repeat r) {
            o.add("children", r.template().deepCopy());
        }
        return o;
    }

    /** A tooltip: the text itself, or the hook that supplies it. */
    private static JsonElement tooltip(final Element.Tooltip t) {
        if (t.isHook()) {
            JsonObject o = new JsonObject();
            o.addProperty("hook", t.hook());
            return o;
        }
        return text(t.text());
    }

    /** {@code "can_apply"} for the {@code != 0} case, else the object form with its comparator. */
    private static JsonElement predicate(final Element.Predicate p) {
        if (p.cmp() == Element.Cmp.NE && p.value() == 0) {
            return new JsonPrimitive(p.binding());
        }
        JsonObject o = new JsonObject();
        o.addProperty("binding", p.binding());
        o.addProperty(p.cmp().jsonName(), p.value());
        return o;
    }

    /** A float as the shortest number that reads back the same: {@code 25} rather than {@code 25.0}. */
    private static JsonElement number(final float f) {
        return f == Math.rint(f) && Math.abs(f) < 1e9F
            ? new JsonPrimitive((int) f) : new JsonPrimitive(f);
    }

    private static void placeholder(final JsonObject o, final Element.Placeholder ph) {
        if (ph == null) {
            return;
        }
        if (ph.count() == 1) {
            o.addProperty("placeholder", ph.item());
        } else {
            JsonObject po = new JsonObject();
            po.addProperty("item", ph.item());
            po.addProperty("count", ph.count());
            o.add("placeholder", po);
        }
    }

    private static JsonElement text(final Text t) {
        if (t.isTranslation()) {
            JsonObject o = new JsonObject();
            o.addProperty("translate", t.translate());
            return o;
        }
        return new JsonPrimitive(t.literal());
    }

    private static JsonArray point(final int x, final int y) {
        JsonArray a = new JsonArray();
        a.add(x);
        a.add(y);
        return a;
    }

    // ---------------------------------------------------------------------------------------------

    /**
     * Gson's pretty printer puts every array element on its own line, which turns {@code [8, 6]} into
     * three lines and a slot grid into a wall. This one keeps arrays of primitives inline and indents
     * everything else by two spaces - the shape a human diffs.
     */
    public static String pretty(final JsonElement e) {
        StringBuilder sb = new StringBuilder();
        print(e, sb, 0);
        return sb.toString();
    }

    private static void print(final JsonElement e, final StringBuilder sb, final int indent) {
        if (e.isJsonObject()) {
            JsonObject o = e.getAsJsonObject();
            if (o.isEmpty()) {
                sb.append("{}");
                return;
            }
            sb.append("{\n");
            int i = 0;
            for (Map.Entry<String, JsonElement> en : o.entrySet()) {
                pad(sb, indent + 1);
                sb.append(quote(en.getKey())).append(": ");
                print(en.getValue(), sb, indent + 1);
                sb.append(++i < o.size() ? ",\n" : "\n");
            }
            pad(sb, indent);
            sb.append('}');
        } else if (e.isJsonArray()) {
            JsonArray a = e.getAsJsonArray();
            if (a.isEmpty()) {
                sb.append("[]");
                return;
            }
            boolean flat = true;
            for (JsonElement x : a) {
                if (!x.isJsonPrimitive()) {
                    flat = false;
                    break;
                }
            }
            if (flat) {
                sb.append('[');
                for (int i = 0; i < a.size(); i++) {
                    if (i > 0) {
                        sb.append(", ");
                    }
                    print(a.get(i), sb, indent);
                }
                sb.append(']');
            } else {
                sb.append("[\n");
                for (int i = 0; i < a.size(); i++) {
                    pad(sb, indent + 1);
                    print(a.get(i), sb, indent + 1);
                    sb.append(i + 1 < a.size() ? ",\n" : "\n");
                }
                pad(sb, indent);
                sb.append(']');
            }
        } else if (e.isJsonPrimitive() && e.getAsJsonPrimitive().isString()) {
            sb.append(quote(e.getAsString()));
        } else {
            sb.append(e);
        }
    }

    private static void pad(final StringBuilder sb, final int indent) {
        for (int i = 0; i < indent; i++) {
            sb.append("  ");
        }
    }

    private static String quote(final String s) {
        StringBuilder sb = new StringBuilder(s.length() + 2).append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> sb.append("\\\"");
                case '\\' -> sb.append("\\\\");
                case '\n' -> sb.append("\\n");
                case '\r' -> sb.append("\\r");
                case '\t' -> sb.append("\\t");
                default -> {
                    if (c < 0x20) {
                        sb.append(String.format("\\u%04x", (int) c));
                    } else {
                        sb.append(c);
                    }
                }
            }
        }
        return sb.append('"').toString();
    }
}
