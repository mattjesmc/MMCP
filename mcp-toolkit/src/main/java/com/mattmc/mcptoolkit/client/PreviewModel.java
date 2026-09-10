package com.mattmc.mcptoolkit.client;

import net.fabricmc.api.EnvType;
import net.fabricmc.api.Environment;
import net.minecraft.client.animation.KeyframeAnimation;
import net.minecraft.client.model.EntityModel;
import net.minecraft.client.model.geom.ModelPart;
import org.jspecify.annotations.Nullable;

import java.util.Map;
import java.util.Set;

/**
 * A model baked from an interchange file — deliberately empty of behaviour. Every part pose it has
 * came out of the JSON, and the only thing this class decides is WHICH INSTANT of an authored clip
 * to show; the poses themselves are vanilla's own {@link KeyframeAnimation}, driven by numbers the
 * plugin wrote (ENTITY_AUTHORING_DESIGN.md §9.2).
 *
 * <p><b>The clips are baked against THIS root and live in THIS object</b>, rather than being looked
 * up beside it. A {@code KeyframeAnimation} holds direct references to the {@link ModelPart}s it
 * animates, so a clip baked against one bake and applied to another would silently pose a model
 * nobody is looking at. Keeping the two together makes that unrepresentable rather than merely
 * unlikely.
 *
 * <p><b>{@code Model.setupAnim}'s default — reset every part to its authored pose — is still the
 * whole rest-pose story</b>, and stays the first thing that happens: vanilla's animation targets
 * are {@code offset*} methods that ADD to whatever pose a part is already in, so applying a clip
 * without resetting first would accumulate the offset every frame.
 */
@Environment(EnvType.CLIENT)
public class PreviewModel extends EntityModel<PreviewRenderState> {

    /** Milliseconds per tick — the unit {@code KeyframeAnimation.apply} takes. */
    private static final float MS_PER_TICK = 50.0F;

    private final Map<String, KeyframeAnimation> clips;

    public PreviewModel(final ModelPart root, final Map<String, KeyframeAnimation> clips) {
        super(root);
        this.clips = clips;
    }

    /** The clip names this model carries, for {@code stage_entity} to echo back to an author. */
    public Set<String> clipNames() {
        return this.clips.keySet();
    }

    public boolean hasClip(final @Nullable String name) {
        return name != null && !name.isEmpty() && this.clips.containsKey(name);
    }

    /**
     * Rest pose, then the named clip if there is one.
     *
     * <p><b>Playing runs off {@code ageInTicks}, not an {@code AnimationState}</b>, and that is a
     * simplification the subject earns: a preview never starts, stops or blends a clip, so the only
     * thing an {@code AnimationState} would contribute is a start instant — which for a body that
     * has been playing one looping clip since it was staged is exactly its own age. It also makes
     * the played pose a pure function of the render state, so a screenshot at a known age is
     * reproducible.
     *
     * <p>A negative {@code clipTime} means PLAY; anything else is a scrub, frozen at that second
     * (§5.1). Looping is applied by {@code KeyframeAnimation} itself, so a scrub past the end of a
     * looping clip wraps and past the end of a non-looping one holds — vanilla's rules, not ours.
     */
    @Override
    public void setupAnim(final PreviewRenderState state) {
        super.setupAnim(state);
        KeyframeAnimation clip = this.clips.get(state.clip);
        if (clip == null) {
            return;
        }
        long millis = state.clipTime < 0.0F
            ? (long) (state.ageInTicks * MS_PER_TICK)
            : (long) (state.clipTime * 1000.0F);
        clip.apply(millis, 1.0F);
    }
}
