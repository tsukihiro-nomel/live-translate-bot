import { SlashCommandBuilder } from 'discord.js';
import { getGuildConfig, setGuildConfig, updateGuildGlossary } from '../store.js';
import { log } from '../logger.js';

export const liveCommand = new SlashCommandBuilder()
  .setName('live')
  .setDescription('Traduction live (vocal -> overlay)')
  .addSubcommand((s) => s.setName('on').setDescription('Démarrer le live dans ton vocal actuel'))
  .addSubcommand((s) => s.setName('off').setDescription('Arrêter le live'))
  .addSubcommand((s) =>
    s
      .setName('target')
      .setDescription('Définir la langue cible (ex: fr, en, ja)')
      .addStringOption((o) => o.setName('lang').setDescription('ISO-639-1 (ex: fr)').setRequired(true))
  )
  .addSubcommand((s) =>
    s
      .setName('overlaytoken')
      .setDescription('Définir le token WS pour l\'overlay (par serveur)')
      .addStringOption((o) => o.setName('token').setDescription('token').setRequired(true))
  )
  .addSubcommandGroup((g) =>
    g
      .setName('glossary')
      .setDescription('Glossaire serveur (noms propres / jargon)')
      .addSubcommand((s) =>
        s
          .setName('add')
          .setDescription('Ajouter une règle')
          .addStringOption((o) => o.setName('source').setDescription('Terme original').setRequired(true))
          .addStringOption((o) => o.setName('target').setDescription('Terme forcé').setRequired(true))
      )
      .addSubcommand((s) => s.setName('list').setDescription('Lister les règles'))
      .addSubcommand((s) =>
        s
          .setName('remove')
          .setDescription('Supprimer une règle')
          .addStringOption((o) => o.setName('source').setDescription('Terme original').setRequired(true))
      )
  );

export async function handleLiveCommand({ interaction, liveManager }) {
  const guild = interaction.guild;
  if (!guild) {
    await interaction.reply({ content: 'Cette commande doit être utilisée dans un serveur.', ephemeral: true });
    return;
  }

  const sub = interaction.options.getSubcommand();
  const group = interaction.options.getSubcommandGroup(false);

  if (!group && sub === 'on') {
    const member = await guild.members.fetch(interaction.user.id);
    const vc = member.voice?.channel;

    if (!vc) {
      await interaction.reply({ content: 'Tu dois être dans un salon vocal pour lancer le live.', ephemeral: true });
      return;
    }

    await interaction.reply({ content: `✅ Live démarré dans **${vc.name}**.`, ephemeral: true });

    try {
      await liveManager.start({ guild, voiceChannel: vc, textChannel: interaction.channel });
    } catch (e) {
      log.warn({ err: e }, 'Failed to start live');
      await interaction.followUp({ content: '❌ Impossible de démarrer le live (check logs / permissions).', ephemeral: true });
    }
    return;
  }

  if (!group && sub === 'off') {
    const ok = await liveManager.stop(guild.id);
    await interaction.reply({
      content: ok ? '🛑 Live stoppé.' : 'Aucun live actif sur ce serveur.',
      ephemeral: true
    });
    return;
  }

  if (!group && sub === 'target') {
    const lang = interaction.options.getString('lang', true).trim();
    await setGuildConfig(guild.id, { targetLang: lang.toLowerCase() });
    await interaction.reply({ content: `🌐 Langue cible: **${lang.toLowerCase()}**`, ephemeral: true });
    return;
  }

  if (!group && sub === 'overlaytoken') {
    const token = interaction.options.getString('token', true).trim();
    await setGuildConfig(guild.id, { overlayToken: token });
    await interaction.reply({
      content:
        `🔑 Token overlay défini pour ce serveur.\n` +
        `URL OBS: http://localhost:3000/overlay?guild=${guild.id}&token=${encodeURIComponent(token)}`,
      ephemeral: true
    });
    return;
  }

  if (group === 'glossary') {
    const gsub = interaction.options.getSubcommand();

    if (gsub === 'add') {
      const source = interaction.options.getString('source', true);
      const target = interaction.options.getString('target', true);
      await updateGuildGlossary(guild.id, (gloss) => {
        gloss[source] = target;
        return gloss;
      });
      await interaction.reply({ content: `✅ Ajouté: **${source}** → **${target}**`, ephemeral: true });
      return;
    }

    if (gsub === 'remove') {
      const source = interaction.options.getString('source', true);
      await updateGuildGlossary(guild.id, (gloss) => {
        delete gloss[source];
        return gloss;
      });
      await interaction.reply({ content: `🗑️ Supprimé: **${source}**`, ephemeral: true });
      return;
    }

    if (gsub === 'list') {
      const cfg = await getGuildConfig(guild.id);
      const entries = Object.entries(cfg.glossary || {});
      if (!entries.length) {
        await interaction.reply({ content: 'Glossaire vide.', ephemeral: true });
        return;
      }
      const lines = entries
        .slice(0, 40)
        .map(([k, v]) => `• ${k} → ${v}`)
        .join('\n');
      await interaction.reply({ content: `📚 Glossaire (max 40 affichés):\n${lines}`, ephemeral: true });
      return;
    }
  }

  await interaction.reply({ content: 'Commande inconnue.', ephemeral: true });
}
