package com.mattmc.mcptoolkit.ui.interp;

import org.jspecify.annotations.Nullable;

import java.lang.reflect.Method;

/**
 * How the interpreter reads a document's bindings (SCREEN_AUTHORING_DESIGN.md section 8.2) off
 * whatever menu it is showing.
 *
 * <p>Detached, {@link DetachedMenu} implements this over the bindings' {@code preview} values.
 * <b>Attached (slice 6), the menu is a mod's own compiled {@code <Screen>MenuBase}, and it cannot
 * implement this interface</b> - generated code depends on nothing, this toolkit included. So it
 * carries the same METHOD without the interface ({@code public int bindingValue(String)}), and
 * {@link #bind(Object)} reads either shape, exactly as {@link UiDeclared#of(Object)} reads a
 * generated widget's {@code uiId()}/{@code uiKind()} pair. That is open decision 8, answered: the
 * interpreter never learns how a value travelled, only its name.
 *
 * <p>Minecraft-free on purpose: the adapter is a method lookup, and keeping it so is what lets the
 * unit battery falsify it without a game.
 */
public interface UiBindings {
    /** The current value of a declared binding; {@code 0} for a name the menu does not know. */
    int bindingValue(String name);

    /** Which shape answered - reported by {@code get_screen}, so a silent "all zeroes" has a cause. */
    enum Source {
        /** The toolkit's own menu: the interface. */
        INTERFACE,
        /** A generated menu: the duck-typed {@code int bindingValue(String)}. */
        SHAPE,
        /** Neither. Every binding reads 0, and the report says so rather than showing empty gauges. */
        NONE
    }

    /** What a menu can answer, and how it answered it. */
    record Bound(UiBindings values, Source source) {
        public boolean answers() {
            return source != Source.NONE;
        }
    }

    /**
     * Bind to a menu by interface first, then by shape. Never null and never throws: a menu that
     * answers nothing yields zeroes and {@link Source#NONE}, because a preview whose gauges are
     * empty must still draw.
     */
    static Bound bind(final @Nullable Object menu) {
        if (menu instanceof UiBindings ub) {
            return new Bound(ub, Source.INTERFACE);
        }
        if (menu == null) {
            return new Bound(name -> 0, Source.NONE);
        }
        Method m;
        try {
            m = menu.getClass().getMethod("bindingValue", String.class);
        } catch (NoSuchMethodException e) {
            return new Bound(name -> 0, Source.NONE);
        }
        if (m.getReturnType() != int.class && m.getReturnType() != Integer.class) {
            // A `bindingValue` that answers something else is somebody else's method, not this contract.
            return new Bound(name -> 0, Source.NONE);
        }
        return new Bound(name -> {
            try {
                Object v = m.invoke(menu, name);
                return v instanceof Integer i ? i : 0;
            } catch (ReflectiveOperationException | RuntimeException e) {
                return 0;
            }
        }, Source.SHAPE);
    }
}
