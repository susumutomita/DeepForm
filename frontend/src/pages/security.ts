import { t } from '../i18n';

export function renderSecurityPolicy(): string {
  return `
<article class="policy-page">
  <p class="policy-meta">${t('security.lastUpdated')}</p>
  <h1>${t('security.title')}</h1>
  <p>${t('security.intro')}</p>

  <h2>${t('security.s1.title')}</h2>
  <p>${t('security.s1.desc1')}</p>
  <p><strong>${t('security.s1.desc2')}</strong></p>

  <h2>${t('security.s2.title')}</h2>
  <p>${t('security.s2.desc')}</p>

  <h2>${t('security.s3.title')}</h2>
  <p>${t('security.s3.desc')}</p>
  <ul>
    <li>${t('security.s3.item1')}</li>
    <li>${t('security.s3.item2')}</li>
    <li>${t('security.s3.item3')}</li>
  </ul>

  <h2>${t('security.s4.title')}</h2>
  <p>${t('security.s4.desc')}</p>
  <ul>
    <li>${t('security.s4.item1')}</li>
    <li>${t('security.s4.item2')}</li>
    <li>${t('security.s4.item3')}</li>
  </ul>

  <h2>${t('security.s5.title')}</h2>
  <p>${t('security.s5.desc')}</p>

  <h2>${t('security.s6.title')}</h2>
  <p>${t('security.s6.desc')}</p>

  <h2>${t('security.s7.title')}</h2>
  <p>${t('security.s7.desc')}</p>
  <ul>
    <li>${t('security.s7.item1')}</li>
    <li>${t('security.s7.item2')}</li>
    <li>${t('security.s7.item3')}</li>
  </ul>

  <h2>${t('security.s8.title')}</h2>
  <p>${t('security.s8.desc')}</p>

  <h2>${t('security.s9.title')}</h2>
  <p>${t('security.s9.desc')}</p>

  <h2>${t('security.s10.title')}</h2>
  <p>${t('security.s10.desc')}</p>
</article>
`;
}
