package com.mattmc.mcptoolkit.ui.interp;

import com.mattmc.mcptoolkit.ui.doc.Kind;
import org.jspecify.annotations.Nullable;

import java.lang.reflect.Method;

/**
 * A widget that came from a document element, and says which.
 *
 * <p>This is how {@code get_screen} names a declared widget (SCREEN_AUTHORING_DESIGN.md section 1,
 * point 4): a widget that implements it carries its element's {@code id} and {@code kind} into the
 * widget tree, and {@code click}/{@code check_layout} inherit that for free because they already
 * read the same tree.
 *
 * <p><b>Generated screens cannot implement this interface</b> - they depend on nothing, this
 * toolkit included - so their vendored widgets carry the same two methods with {@code String}
 * results ({@code uiId()}, {@code uiKind()}), and {@link #of(Object)} reads either shape. That is
 * what makes section 12's geometry comparison a comparison of like with like: the same tree reader,
 * over the interpreter's widgets and over a shipped mod's.
 */
public interface UiDeclared {
    /** The element's declared id, or {@code null} for an unnamed element. */
    @Nullable String uiId();

    Kind uiKind();

    /**
     * The declaration behind any widget: the interface when implemented, else the duck-typed pair a
     * generated {@code <Mod>Ui} widget carries, else {@code null}.
     */
    static @Nullable UiDeclared of(final Object widget) {
        if (widget instanceof UiDeclared d) {
            return d;
        }
        try {
            Method id = widget.getClass().getMethod("uiId");
            Method kind = widget.getClass().getMethod("uiKind");
            if (id.getReturnType() != String.class || kind.getReturnType() != String.class) {
                return null;
            }
            Kind k = Kind.forName((String) kind.invoke(widget));
            if (k == null) {
                return null;
            }
            String i = (String) id.invoke(widget);
            return new UiDeclared() {
                @Override
                public @Nullable String uiId() {
                    return i;
                }

                @Override
                public Kind uiKind() {
                    return k;
                }
            };
        } catch (ReflectiveOperationException | RuntimeException e) {
            return null;
        }
    }
}
