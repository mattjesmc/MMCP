package com.mattmc.mcptoolkit.ui.doc;

/**
 * A piece of text as the document states it: a literal string or a translation key.
 *
 * <p>JSON: a bare string is a literal; {@code {"translate": "gui.mymod.title"}} is a key. The
 * interpreter turns these into {@code Component.literal} / {@code Component.translatable}, and the
 * emitter prints exactly those two calls - which is why the model carries the distinction rather
 * than a resolved string. Exactly one of the two fields is non-null.
 */
public record Text(String literal, String translate) {
    public Text {
        if ((literal == null) == (translate == null)) {
            throw new IllegalArgumentException("Text is either a literal or a translation key");
        }
    }

    public static Text literal(final String s) {
        return new Text(s, null);
    }

    public static Text translate(final String key) {
        return new Text(null, key);
    }

    public boolean isTranslation() {
        return translate != null;
    }

    /** The literal, or the key when there is no literal - what a widget label reads as before i18n. */
    public String raw() {
        return literal != null ? literal : translate;
    }
}
