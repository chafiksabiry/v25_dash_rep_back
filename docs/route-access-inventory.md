# Inventaire des routes sans contrôle de propriété

Établi à partir du code de la branche `claude/ws-auth-and-recheck-ownership` (HEAD de la PR #6), pour classement par la Sécurité et le CTO :
**lecture publique légitime / propriétaire seul / rôle entreprise**. Aucune de ces routes n'a été modifiée.

## Ce que le code montre (faits)

- Toutes les routes ci-dessous passent par `authenticateToken` (`routes/profileRoutes.js:20`). Aucune ne vérifie que `:id` appartient au jeton.
- **Presque toutes sont des mandataires (proxy)** : `ProfileService` / `ExternalProfileService` appellent le service externe `REP_PROFILE_API` (`/profiles/:id`, `/profiles/:id/plan`) en **relayant le jeton Bearer de l'appelant** (`ExternalProfileService.js:46,88` ; `ProfileService.js:53-54,301-302`). Le contrôle d'accès effectif dépend donc **de ce service externe**, non vérifiable depuis ce dépôt.
- Conséquence avec `ALLOW_HEADER_AUTH=true` (appelant sans jeton) : la requête passe ici mais part **sans jeton** vers le service externe (comportement à confirmer côté service externe).
- **Qui appelle** : aucun appelant n'est visible dans ce dépôt (backend seul). La colonne « Appelant (d'après le code) » indique donc uniquement ce qui est déductible ici ; les clients (front REPS, entreprises, autres services) sont à renseigner par la Sécurité / les sessions front.

## Routes à classer

| # | Méthode et route | Handler | Donnée lue / écrite | Identité utilisée | Appelant (d'après le code) |
|---|---|---|---|---|---|
| 1 | `GET /api/profiles/user/:id` | `getProfileById` | **Lit** le profil complet de `:id` via `REP_PROFILE_API` `GET /profiles/:id` (donnée personnelle, expériences, compétences, langues…). Le commentaire du code dit « for testing ». | `:id` du chemin ; jeton relayé | inconnu (non déductible ici) |
| 2 | `PUT /api/profiles/:id` | `updateProfile` | **Écrit** le profil de `:id` (corps entier, aplati) via `PUT /profiles/:id` | `:id` ; jeton relayé | inconnu |
| 3 | `PUT /api/profiles/:id/basic-info` | `updateBasicInfo` | **Écrit** les informations de base de `:id` (même `updateProfile`) | `:id` ; jeton relayé | inconnu |
| 4 | `PUT /api/profiles/:id/experience` | `updateExperience` | **Écrit** les expériences de `:id` | `:id` ; jeton relayé | inconnu |
| 5 | `PUT /api/profiles/:id/skills` | `updateSkills` | **Écrit** les compétences de `:id` | `:id` ; jeton relayé | inconnu |
| 6 | `POST /api/profiles/:id/language-assessment` | `addLanguageAssessment` | **Lit** le profil de `:id` puis **écrit** une évaluation de langue (`ProfileService.js:161-`) | `:id` ; jeton relayé | inconnu |
| 7 | `POST /api/profiles/:id/contact-center-assessment` | `addContactCenterAssessment` | **Lit** puis **écrit** une évaluation « contact center » pour `:id` (`ProfileService.js:212-`) | `:id` ; jeton relayé | inconnu |
| 8 | `GET /api/profiles/:id/exists` | `checkProfileExists` | **Lit** le profil de `:id` mais ne renvoie qu'un booléen d'existence (`ProfileService.js:271-`). `:id` facultatif : retombe sur `req.user.id`. | `:id` ou jeton ; jeton relayé | inconnu |
| 9 | `GET /api/profiles/:id/plan` | `getPlan` | **Lit** le plan d'abonnement de `:id` via `GET /profiles/:id/plan` | `:id` ; jeton relayé | inconnu |
| 10 | `GET /api/profiles/:id/language/analyze-video/jobs/:jobId` | `getLanguageVideoJobStatus` | **Lit** un job d'analyse de langue (statut, et résultat complet si terminé : scores, évaluation) filtré par `profileId` **et** `jobId` (`LanguageVideoJobService.js:113-115`, base locale). Exige de connaître l'identifiant du job (ObjectId), mais **pas** d'être le propriétaire. | `:id` + `:jobId` | polling après `POST /:id/language/analyze-video` (protégée, elle) |

## Routes déjà liées à l'identité du jeton (pas de problème de propriété)

| Méthode et route | Pourquoi |
|---|---|
| `GET /api/profiles/` | utilise `req.user.id` |
| `PUT /api/profiles/` | sans `:id` → refusée 400 (`updateProfile` exige `req.params.id`) |
| `GET /api/profiles/reps-score`, `GET /api/profiles/completion-status` | utilisent `req.user.id` |
| `/api/notifications/*` | identité dérivée du jeton vérifié (PR #5) |
| `POST /:id/identity/recheck`, `/:id/language/accent/recheck`, `/:id/experience/analyze-video`, `/:id/language/analyze-video`, `/:id/presentation/analyze-video` | `requireProfileOwnership` (PR #5 / #6 / #3) |

## Points à trancher

1. **Le service externe `REP_PROFILE_API` applique-t-il lui-même la propriété** sur `GET/PUT /profiles/:id` ? Si oui, les routes 1-9 sont déjà protégées en pratique ; sinon, c'est ce dépôt qui expose l'IDOR.
2. Routes **légitimement multi-identités** à identifier (CTO : entreprise qui consulte un REP) : probablement la route 1 (`/user/:id`) et peut-être 8-9 ; les routes **d'écriture 2-7** semblent propriétaire seul, à confirmer.
3. La route 10 peut être alignée sur `requireProfileOwnership` sans impact attendu : le polling suit un `POST` déjà réservé au propriétaire.
4. Mode `ALLOW_HEADER_AUTH=true` : décider si ces routes doivent refuser l'identité non vérifiée.

## Limites de cet inventaire

- Les appelants réels ne sont pas déductibles de ce dépôt.
- Le comportement du service externe n'a pas été examiné.
- Aucune route n'a été exécutée ; classement basé sur la lecture du code uniquement.
