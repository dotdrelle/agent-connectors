FROM node:22-alpine

WORKDIR /app

# `--chown=node:node` sur tout ce qui est copié depuis le contexte.
#
# `COPY` conserve les bits de permission du fichier hôte et donne le fichier à
# root. Le conteneur tourne ensuite en `node` : sur une machine dont l'umask est
# restrictif (fichiers en 600), la source devenait illisible pour lui et le
# démarrage échouait en `EACCES: permission denied, open '/app/src/index.ts'`.
# La panne dépendait donc de l'umask de qui construit — invisible en CI, fatale
# en local. `--chown` rend l'image indépendante de l'hôte, comme le fait déjà
# le Dockerfile de llm-wiki.
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --omit=dev && chown -R node:node /app/node_modules

COPY --chown=node:node src ./src

# Application OAuth wikiLLM embarquée comme DÉFAUT.
#
# Elle vivait dans un couple ARG/ENV, que BuildKit signale à raison
# (`SecretsUsedInArgOrEnv`) : un `ENV` reste inscrit dans les métadonnées de
# l'image et ressort à chaque `docker inspect`. Ici c'est un fichier en lecture
# seule, détenu par l'utilisateur d'exécution, hors de la configuration du
# conteneur. Le client Google distribué est de type Desktop/public : ces valeurs
# ne sont pas une frontière de sécurité, mais elles n'ont rien à faire dans
# l'environnement.
#
# Le fichier est produit par build-local.sh / build-and-push.sh à partir de
# .env.build.local. Il est facultatif : sans lui l'agent démarre et le dit,
# seule l'autorisation Google reste indisponible. Le `*` rend la copie
# tolérante à son absence.
COPY --chown=node:node .oauth-clien[t].json ./.oauth-client.json
RUN chmod 400 /app/.oauth-client.json 2>/dev/null || true

USER node

ENV CONNECTORS_PORT=3338
EXPOSE 3338

CMD ["npm", "start"]
