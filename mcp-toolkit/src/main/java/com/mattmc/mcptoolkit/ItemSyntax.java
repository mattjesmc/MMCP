package com.mattmc.mcptoolkit;

import com.mojang.brigadier.StringReader;
import com.mojang.brigadier.exceptions.CommandSyntaxException;
import net.minecraft.commands.arguments.item.ItemParser;
import net.minecraft.core.HolderLookup;
import net.minecraft.world.item.ItemStack;

/**
 * One stack from the game's own item syntax - {@code minecraft:diamond_sword[enchantments={...}]},
 * components included - through vanilla's {@code ItemParser}, the parser {@code /give} and
 * {@code /item replace} use. One place, because three tools spell the same thing: {@code roll_loot}'s
 * {@code tool}, {@code get_tooltip}'s {@code item}, and the studio's {@code equipment} (RELEASE_1.md
 * section K2, K3). A bad spec is an {@link IllegalArgumentException} naming the argument and the
 * parser's own reason, which is what the caller's {@code ArgCheck} gate turns into a refusal.
 */
public final class ItemSyntax {

    private ItemSyntax() {}

    public static ItemStack parse(final HolderLookup.Provider registries, final String argName,
                                  final String spec, final int count) {
        try {
            return new ItemParser(registries).parse(new StringReader(spec)).createItemStack(count);
        } catch (CommandSyntaxException e) {
            throw new IllegalArgumentException("bad `" + argName + "` '" + spec + "': " + e.getMessage());
        }
    }
}
