package com.example.examplemod;

import com.example.examplemod.registry.RegisterExampleBlock;
import net.fabricmc.api.ModInitializer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The mod's entrypoint. Everything registered here is registered before the registries freeze; a
 * class scaffolded by {@code gradlew scaffold} is called from here, once, by its {@code register()}.
 */
public class ExampleMod implements ModInitializer {
    public static final String MOD_ID = "examplemod";
    public static final Logger LOGGER = LoggerFactory.getLogger(MOD_ID);

    @Override
    public void onInitialize() {
        RegisterExampleBlock.register();
        LOGGER.info("[{}] initialised", MOD_ID);
    }
}
