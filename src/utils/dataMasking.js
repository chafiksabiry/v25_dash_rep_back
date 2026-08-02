/**
 * Utilitaires de masquage des données sensibles
 * Conforme aux exigences de confidentialité du rapport PFE
 */

/**
 * Masque un numéro de téléphone en n'affichant que les 4 premiers chiffres
 * 
 * @param {string} phone - Numéro de téléphone à masquer
 * @returns {string} Numéro masqué (ex: "+212 6123 ** ** **" ou "0612 ** ** **")
 * 
 * @example
 * maskPhone("+212612345678") // "+212 6123 ** ** **"
 * maskPhone("0612345678")    // "0612 ** ** **"
 * maskPhone("5147891234")    // "5147 ** ** **"
 */
function maskPhone(phone) {
  if (!phone || phone.trim() === '') {
    return '';
  }

  // Nettoyer le numéro (enlever espaces, tirets, points, parenthèses)
  const cleaned = phone.replace(/[\s\-\.()]/g, '');
  
  // Extraire le préfixe international si présent (+ suivi de chiffres)
  const internationalMatch = cleaned.match(/^(\+\d+)(\d+)$/);
  
  if (internationalMatch) {
    const prefix = internationalMatch[1]; // ex: "+212"
    const number = internationalMatch[2]; // ex: "612345678"
    
    if (number.length >= 4) {
      const firstFour = number.substring(0, 4);
      const masked = '** ** **';
      return `${prefix} ${firstFour} ${masked}`;
    }
  }
  
  // Si pas de préfixe international, extraire les chiffres
  const digitsOnly = cleaned.replace(/\D/g, '');
  
  if (digitsOnly.length >= 4) {
    const firstFour = digitsOnly.substring(0, 4);
    const masked = '** ** **';
    return `${firstFour} ${masked}`;
  }
  
  // Si moins de 4 chiffres, masquer complètement
  return '** ** ** **';
}

/**
 * Masque une adresse email en n'affichant que les 2 premières lettres + domaine
 * 
 * @param {string} email - Adresse email à masquer
 * @returns {string} Email masqué (ex: "ab****@gmail.com")
 * 
 * @example
 * maskEmail("alice.bernard@gmail.com")  // "ab****@gmail.com"
 * maskEmail("john.doe@harx.com")        // "jo****@harx.com"
 */
function maskEmail(email) {
  if (!email || email.trim() === '') {
    return '';
  }

  // Valider le format email basique
  const emailRegex = /^([^@]+)@([^@]+)$/;
  const match = email.match(emailRegex);
  
  if (!match) {
    // Email invalide, masquer complètement
    return '****@****.***';
  }

  const localPart = match[1];
  const domain = match[2];
  
  // Extraire les 2 premières lettres (ignorer les caractères non-alphabétiques)
  const letters = localPart.replace(/[^a-zA-Z]/g, '');
  
  if (letters.length >= 2) {
    const firstTwo = letters.substring(0, 2).toLowerCase();
    return `${firstTwo}****@${domain}`;
  } else if (letters.length === 1) {
    const firstOne = letters.substring(0, 1).toLowerCase();
    return `${firstOne}*****@${domain}`;
  } else {
    // Pas de lettres, masquer différemment
    return `****@${domain}`;
  }
}

/**
 * Masque un nom complet en gardant initiale + nom de famille
 * 
 * @param {string} fullName - Nom complet à masquer
 * @returns {string} Nom masqué (ex: "John Doe" -> "John D.")
 */
function maskName(fullName) {
  if (!fullName || fullName.trim() === '') {
    return '';
  }

  const parts = fullName.trim().split(/\s+/);
  
  if (parts.length === 1) {
    // Un seul nom, ne pas masquer
    return parts[0];
  }
  
  // Prendre le prénom + initiale du nom de famille
  const firstName = parts[0];
  const lastNameInitial = parts[parts.length - 1].charAt(0).toUpperCase();
  
  return `${firstName} ${lastNameInitial}.`;
}

/**
 * Masque un montant financier (optionnel selon contexte)
 * 
 * @param {number} amount - Montant à masquer
 * @param {string} currency - Devise (défaut: "€")
 * @returns {string} Montant masqué
 */
function maskAmount(amount, currency = '€') {
  return `***.**${currency}`;
}

/**
 * Masque partiellement un token ou ID
 * 
 * @param {string} token - Token à masquer
 * @param {number} visibleChars - Nombre de caractères visibles au début et fin
 * @returns {string} Token masqué
 */
function maskToken(token, visibleChars = 4) {
  if (!token || token.length <= visibleChars * 2) {
    return '••••••••••';
  }

  const start = token.substring(0, visibleChars);
  const end = token.substring(token.length - visibleChars);
  const middle = '••••••••';
  
  return `${start}${middle}${end}`;
}

/**
 * Masque les données sensibles dans un objet (mutation)
 * Utile pour les réponses API
 * 
 * @param {Object} obj - Objet à traiter
 * @param {Object} options - Options de masquage
 * @returns {Object} Objet avec données masquées
 */
function maskSensitiveFields(obj, options = {}) {
  const {
    phoneFields = ['phone', 'telephone', 'mobile', 'phoneNumber', 'tel'],
    emailFields = ['email', 'emailAddress', 'mail'],
    nameFields = ['fullName', 'name', 'displayName'],
    tokenFields = ['token', 'apiKey', 'secretKey', 'accessToken'],
  } = options;

  if (!obj || typeof obj !== 'object') {
    return obj;
  }

  // Traiter les tableaux
  if (Array.isArray(obj)) {
    return obj.map(item => maskSensitiveFields(item, options));
  }

  // Traiter les objets
  const masked = { ...obj };

  for (const key in masked) {
    if (masked.hasOwnProperty(key)) {
      const value = masked[key];

      // Masquer les téléphones
      if (phoneFields.includes(key) && typeof value === 'string') {
        masked[key] = maskPhone(value);
      }
      // Masquer les emails
      else if (emailFields.includes(key) && typeof value === 'string') {
        masked[key] = maskEmail(value);
      }
      // Masquer les noms
      else if (nameFields.includes(key) && typeof value === 'string') {
        masked[key] = maskName(value);
      }
      // Masquer les tokens
      else if (tokenFields.includes(key) && typeof value === 'string') {
        masked[key] = maskToken(value);
      }
      // Récursion pour les objets imbriqués
      else if (typeof value === 'object' && value !== null) {
        masked[key] = maskSensitiveFields(value, options);
      }
    }
  }

  return masked;
}

/**
 * Middleware Express pour masquer automatiquement les données sensibles
 * dans les réponses API
 * 
 * @example
 * app.use(maskSensitiveDataMiddleware());
 */
function maskSensitiveDataMiddleware(options = {}) {
  return (req, res, next) => {
    const originalJson = res.json;

    res.json = function(data) {
      // Masquer uniquement si l'environnement l'exige
      const shouldMask = options.enabled !== false && 
                        (process.env.MASK_SENSITIVE_DATA === 'true' || 
                         process.env.NODE_ENV === 'production');

      if (shouldMask && data) {
        const maskedData = maskSensitiveFields(data, options);
        return originalJson.call(this, maskedData);
      }

      return originalJson.call(this, data);
    };

    next();
  };
}

module.exports = {
  maskPhone,
  maskEmail,
  maskName,
  maskAmount,
  maskToken,
  maskSensitiveFields,
  maskSensitiveDataMiddleware,
};
