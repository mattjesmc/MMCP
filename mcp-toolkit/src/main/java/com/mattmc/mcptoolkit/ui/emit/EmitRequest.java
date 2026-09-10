package com.mattmc.mcptoolkit.ui.emit;

import java.util.regex.Pattern;

/**
 * What the emitter needs besides the document: whose mod, which package, which screen, which loader.
 *
 * @param modId       the mod's namespace ({@code assets/<modId>/ui/...}); also the vendored file's prefix
 * @param basePackage the mod's root package; generated code lands in {@code .menu} and {@code .client} under it
 * @param screenId    the document's file stem ({@code rocket} for {@code rocket.ui.json}); the resource id's path
 * @param target      the loader dialect
 */
public record EmitRequest(String modId, String basePackage, String screenId, Target target) {
    private static final Pattern STEM = Pattern.compile("[a-z][a-z0-9_]*");
    private static final Pattern PACKAGE = Pattern.compile("[a-z_][a-z0-9_]*(\\.[a-z_][a-z0-9_]*)*");

    public EmitRequest {
        if (!STEM.matcher(modId).matches()) {
            throw new IllegalArgumentException("mod id must be [a-z][a-z0-9_]*, got '" + modId + "'");
        }
        if (!STEM.matcher(screenId).matches()) {
            throw new IllegalArgumentException("a document's file stem names its classes and must be"
                + " [a-z][a-z0-9_]*, got '" + screenId + "'");
        }
        if (!PACKAGE.matcher(basePackage).matches()) {
            throw new IllegalArgumentException("not a package name: '" + basePackage + "'");
        }
        if (target == null) {
            throw new IllegalArgumentException("target is required");
        }
    }

    /** {@code Rocket} for {@code rocket}; the stem of every class name. */
    public String screenClass() {
        return JavaNames.pascal(screenId);
    }

    /**
     * A document stem to its class-name stem, without building a request.
     *
     * <p>{@code ui_doc op:"lint"} needs it to find the generated layout file for a document it is
     * only reading, and {@link JavaNames} is package-private on purpose - the naming rule is the
     * emitter's, and a second copy of it is exactly the drift this project keeps finding.
     */
    public static String pascal(final String stem) {
        return JavaNames.pascal(stem);
    }

    /** {@code RocketeerUi} for mod {@code rocketeer}: the vendored file (section 7). */
    public String vendorClass() {
        return JavaNames.pascal(modId) + "Ui";
    }

    public String menuPackage() {
        return basePackage + ".menu";
    }

    public String clientPackage() {
        return basePackage + ".client";
    }

    public String menuBaseClass() {
        return screenClass() + "MenuBase";
    }

    public String menuClass() {
        return screenClass() + "Menu";
    }

    public String layoutClass() {
        return screenClass() + "Layout";
    }

    public String screenClassName() {
        return screenClass() + "Screen";
    }

    /** The document's resource id, as the generated headers cite it. */
    public String documentPath() {
        return "assets/" + modId + "/ui/" + screenId + ".ui.json";
    }
}
