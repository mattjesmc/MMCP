package com.mattmc.mcptoolkit.ui.emit;

/**
 * The loader dialect the emitter prints (SCREEN_AUTHORING_DESIGN.md section 11).
 *
 * <p>A container GUI is vanilla on both loaders; what differs is enumerated here so the emitter's
 * neutral core never learns a loader's name. The boundary exists from the first line of the emitter
 * because retrofitting it is expensive and adding a second dialect to it is cheap.
 */
public enum Target {
    /** Fabric: {@code @Environment(EnvType.CLIENT)} from fabric-loader, direct registry calls. */
    FABRIC("fabric", true),
    /** NeoForge: designed for, not built - the emitter refuses it by name until after slice 7. */
    NEOFORGE("neoforge", false);

    private final String jsonName;
    private final boolean built;

    Target(final String jsonName, final boolean built) {
        this.jsonName = jsonName;
        this.built = built;
    }

    public String jsonName() {
        return jsonName;
    }

    public boolean isBuilt() {
        return built;
    }

    public static Target forName(final String s) {
        for (Target t : values()) {
            if (t.jsonName.equals(s)) {
                return t;
            }
        }
        return null;
    }

    // ---- the dialect --------------------------------------------------------------------------

    /** Imports a client-only class needs for its environment annotation, or none. */
    String[] clientImports() {
        return switch (this) {
            case FABRIC -> new String[] {"net.fabricmc.api.EnvType", "net.fabricmc.api.Environment"};
            case NEOFORGE -> new String[0];
        };
    }

    /** The annotation line over a client-only class, or {@code null}. */
    String clientAnnotation() {
        return switch (this) {
            case FABRIC -> "@Environment(EnvType.CLIENT)";
            case NEOFORGE -> null;
        };
    }

    /** How the mod registers the menu type - the one common-side line that is the loader's. */
    String registerMenuTypeHint(final String modId, final String screenId, final String menuClass) {
        return switch (this) {
            case FABRIC -> "Registry.register(BuiltInRegistries.MENU, Identifier.fromNamespaceAndPath("
                + JavaNames.str(modId) + ", " + JavaNames.str(screenId) + "), " + menuClass + ".TYPE);"
                + "  // in your ModInitializer";
            case NEOFORGE -> "DeferredRegister.create(Registries.MENU, " + JavaNames.str(modId) + ").register("
                + JavaNames.str(screenId) + ", () -> " + menuClass + ".TYPE);";
        };
    }

    /**
     * What the two registration lines cost on this loader. Vanilla keeps {@code MenuType}'s
     * constructor, its {@code MenuSupplier}, {@code MenuScreens.register} and its
     * {@code ScreenConstructor} all PRIVATE (vanilla's own registrations are the only callers).
     * fabric-api's transitive access wideners open them, NeoForge's access transformer opens them,
     * and a Fabric mod WITHOUT fabric-api must open them itself - an access widener is a
     * fabric-loader feature, so still no dependency, but four lines to add.
     */
    String registrationAccessHint() {
        return switch (this) {
            case FABRIC -> "MenuType's constructor, MenuType.MenuSupplier, MenuScreens.register and"
                + " MenuScreens.ScreenConstructor are private in vanilla. With fabric-api they are already open"
                + " (fabric-transitive-access-wideners-v1). Without it, add to your .accesswidener:\n"
                + "    accessible class net/minecraft/world/inventory/MenuType$MenuSupplier\n"
                + "    accessible method net/minecraft/world/inventory/MenuType <init>"
                + " (Lnet/minecraft/world/inventory/MenuType$MenuSupplier;Lnet/minecraft/world/flag/FeatureFlagSet;)V\n"
                + "    accessible class net/minecraft/client/gui/screens/MenuScreens$ScreenConstructor\n"
                + "    accessible method net/minecraft/client/gui/screens/MenuScreens register"
                + " (Lnet/minecraft/world/inventory/MenuType;Lnet/minecraft/client/gui/screens/MenuScreens$ScreenConstructor;)V";
            case NEOFORGE -> "MenuType's constructor and MenuScreens.register are opened by NeoForge's own access"
                + " transformer; nothing to add";
        };
    }

    /** How the mod registers the screen - the one client-side line that is the loader's. */
    String registerScreenHint(final String menuClass, final String screenClass) {
        return switch (this) {
            case FABRIC -> "MenuScreens.register(" + menuClass + ".TYPE, " + screenClass + "::new);"
                + "  // in your ClientModInitializer";
            case NEOFORGE -> "event.register(" + menuClass + ".TYPE, " + screenClass + "::new);"
                + "  // in a RegisterMenuScreensEvent handler";
        };
    }
}
