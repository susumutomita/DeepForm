import { t } from '../i18n';

export function renderPrivacyPolicy(): string {
  return `
<article class="policy-page">
  <p class="policy-meta">${t('privacy.lastUpdated')}</p>
  <h1>${t('privacy.title')}</h1>
  <p>${t('privacy.intro')}</p>

  <h2>${t('privacy.s1.title')}</h2>
  <p>${t('privacy.s1.desc')}</p>
  <ul>
    <li>${t('privacy.s1.item1')}</li>
    <li>${t('privacy.s1.item2')}</li>
    <li>${t('privacy.s1.item3')}</li>
  </ul>

  <h2>${t('privacy.s2.title')}</h2>
  <p>${t('privacy.s2.desc')}</p>
  <ul>
    <li>${t('privacy.s2.item1')}</li>
    <li>${t('privacy.s2.item2')}</li>
    <li>${t('privacy.s2.item3')}</li>
    <li>${t('privacy.s2.item4')}</li>
    <li>${t('privacy.s2.item5')}</li>
  </ul>

  <h2>${t('privacy.s3.title')}</h2>
  <p>${t('privacy.s3.desc1')}</p>
  <p>${t('privacy.s3.desc2')}</p>

  <h2>${t('privacy.s4.title')}</h2>
  <p>${t('privacy.s4.desc')}</p>

  <h2>${t('privacy.s5.title')}</h2>
  <p>${t('privacy.s5.desc')}</p>

  <h2>${t('privacy.s6.title')}</h2>
  <p>${t('privacy.s6.desc')}</p>

  <h2>${t('privacy.s7.title')}</h2>
  <p>${t('privacy.s7.desc')}</p>
  <ul>
    <li>${t('privacy.s7.item1')}</li>
    <li>${t('privacy.s7.item2')}</li>
    <li>${t('privacy.s7.item3')}</li>
  </ul>

  <h2>${t('privacy.s8.title')}</h2>
  <p>${t('privacy.s8.desc')}</p>

  <h2>${t('privacy.s9.title')}</h2>
  <p>${t('privacy.s9.desc')}</p>
</article>
`;
}
