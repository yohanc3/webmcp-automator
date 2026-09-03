(() => {
  'use strict';

  const NAVIGATION_PATHS = new Map([
    ['/home', ['Go to Home', 'Open the Home timeline.']],
    ['/explore', ['Open Explore', 'Browse topics, trends, and recommendations.']],
    ['/notifications', ['Open Notifications', 'Review account notifications.']],
    ['/i/chat', ['Open Chat', 'Open X chat and direct conversations.']],
    ['/i/grok', ['Open Grok', 'Open the Grok assistant.']],
    ['/i/history', ['Open History', 'Review recent X activity or Grok history.']],
    ['/i/jf/creators/studio', ['Open Creator Studio', 'Manage creator publishing tools.']],
    ['/i/premium_sign_up', ['Open Premium', 'Review or subscribe to X Premium.']],
    ['/compose/post', ['Compose a new post', 'Open the full post composer.']],
    ['/explore/tabs/for-you', ['Show more trends', 'Open the full For You trends view.']],
    ['/i/keyboard_shortcuts', ['View keyboard shortcuts', 'Open X’s keyboard shortcut reference.']],
    ['/tos', ['Read the Terms', 'Open X’s terms of service.']],
    ['/privacy', ['Read the Privacy Policy', 'Open X’s privacy policy.']],
  ]);

  const COMPOSER_TOOLS = new Map([
    ['a18', ['Add media', 'Attach a photo or video to the post.']],
    ['a19', ['Add a GIF', 'Search for and attach a GIF.']],
    ['a20', ['Use the third composer tool', 'Likely a Grok-assisted creation tool; the icon was not captured.']],
    ['a21', ['Add a poll', 'Attach a poll to the post.']],
    ['a22', ['Add an emoji', 'Open the emoji picker.']],
    ['a23', ['Schedule the post', 'Choose a future publishing time.']],
    ['a24', ['Add a location', 'Attach location context when available.']],
    ['a25', ['Use the eighth composer tool', 'The XML proves an icon button here but does not identify its icon.']],
  ]);

  const SPECIFIC_ACTIONS = new Map([
    ['a1', [
      'Use unidentified global control 1',
      'A visible 36px button at the page origin; its icon and label were not captured.',
      'Unclear',
      'unclear',
    ]],
    ['a2', [
      'Use unidentified global control 2',
      'A second visible 36px button at the page origin; its icon and label were not captured.',
      'Unclear',
      'unclear',
    ]],
    ['a3', [
      'Interact with the Home timeline region',
      'A broad interaction region covering the timeline; it is not a reliable discrete control.',
      'Unclear',
      'unclear',
    ]],
    ['a10', [
      'Open timeline controls',
      'Open the icon-only control beside the Home feed tabs.',
      'Timeline',
      'inferred',
    ]],
    ['a11', [
      'Interact with the discovery rail region',
      'A broad interaction region covering the right rail; it is not a reliable discrete control.',
      'Unclear',
      'unclear',
    ]],
    ['a38', [
      'Open Today’s News options',
      'Use the icon-only control for the news module.',
      'Discovery',
      'inferred',
    ]],
    ['a95', [
      'Use floating utility control 1',
      'An icon-only control at the lower-right edge, likely associated with the messages dock.',
      'Unclear',
      'unclear',
    ]],
    ['a104', [
      'Use floating utility control 2',
      'A second icon-only control at the lower-right edge, likely associated with the messages dock.',
      'Unclear',
      'unclear',
    ]],
    ['a103', [
      'Open your account menu',
      'Open account switching, settings, and sign-out options for Elijah (@prof_2k).',
      'Account',
      'confirmed',
    ]],
    ['a141', [
      'Play or pause the soundcore media',
      'Use the central playback control on the promoted media.',
      'Media',
      'inferred',
    ]],
    ['a172', [
      'Play or pause the COD Focused video',
      'Use the central playback control on the embedded video.',
      'Media',
      'inferred',
    ]],
  ]);

  const REGION_LABELS = {
    navigation: 'Primary navigation',
    timeline: 'Home timeline',
    discovery: 'Discovery rail',
    utilities: 'Floating utilities',
  };

  const normalize = (value = '') => value.replace(/\s+/g, ' ').trim();

  const truncate = (value, length = 86) => (
    value.length > length ? `${value.slice(0, length - 1).trim()}…` : value
  );

  const numberAttribute = (attributes, name) => Number.parseFloat(attributes[name] || '0');

  const normalizeRecord = (record, index) => {
    const { attributes } = record;
    return {
      sourceIndex: index,
      parentGroup: record.parentGroup,
      imageIds: record.imageIds || [],
      attributes,
      id: attributes.id,
      tag: attributes.tag,
      type: attributes.type,
      innerText: normalize(attributes['inner-text']),
      href: attributes.href || '',
      classes: attributes.classes || '',
      domId: attributes['dom-id'] || '',
      x: numberAttribute(attributes, 'x'),
      y: numberAttribute(attributes, 'y'),
      width: numberAttribute(attributes, 'width'),
      height: numberAttribute(attributes, 'height'),
    };
  };

  const parsePost = (article) => {
    const match = article.innerText.match(/^(.+?)\s+@([A-Za-z0-9_]+)\s+·\s+([^ ]+)/);
    if (!match) {
      return { author: 'this author', handle: '', time: '', article };
    }
    return {
      author: match[1],
      handle: `@${match[2]}`,
      time: match[3],
      article,
    };
  };

  const postForAction = (action, posts) => {
    const statusLink = action.href.includes('/status/');
    if (action.x >= 1000 && !statusLink) {
      return null;
    }
    return posts.find(({ article }) => (
      action.y >= article.y - 2
      && action.y <= article.y + article.height + 2
    )) || null;
  };

  const regionFor = (action) => {
    if (action.href.includes('/status/') || action.type === 'article') {
      return 'timeline';
    }
    if (action.x < 390) {
      return 'navigation';
    }
    if (action.x >= 1400) {
      return 'utilities';
    }
    if (action.x >= 1000) {
      return 'discovery';
    }
    return 'timeline';
  };

  const description = ({ title, outcome, category, confidence, basis }) => ({
    title,
    outcome,
    category,
    confidence,
    basis,
  });

  const describeSpecific = (action) => {
    const entry = SPECIFIC_ACTIONS.get(action.id);
    if (!entry) {
      return null;
    }
    const [title, outcome, category, confidence] = entry;
    return description({
      title,
      outcome,
      category,
      confidence,
      basis: confidence === 'confirmed'
        ? 'Named inner text in the XML.'
        : 'Inferred from location and X’s interface pattern; the icon is absent.',
    });
  };

  const describeComposerTool = (action) => {
    const entry = COMPOSER_TOOLS.get(action.id);
    if (!entry) {
      return null;
    }
    const [title, outcome] = entry;
    const uncertain = action.id === 'a20' || action.id === 'a25';
    return description({
      title,
      outcome,
      category: 'Compose',
      confidence: uncertain ? 'unclear' : 'inferred',
      basis: 'Inferred from the button’s position in X’s composer toolbar; the icon is absent.',
    });
  };

  const describeEngagementControl = (action, post) => {
    if (!post || action.type !== 'button') {
      return null;
    }
    const distanceFromBottom = (post.article.y + post.article.height) - action.y;
    if (distanceFromBottom < -5 || distanceFromBottom > 52) {
      return null;
    }

    const subject = `${post.author}’s post`;
    const count = action.innerText ? ` Current visible count: ${action.innerText}.` : '';
    if (action.x < 540) {
      return description({
        title: `Reply to ${subject}`,
        outcome: `Open the reply composer.${count}`,
        category: 'Engagement',
        confidence: 'inferred',
        basis: 'First control in the repeated post engagement row.',
      });
    }
    if (action.x < 650) {
      return description({
        title: `Repost ${subject}`,
        outcome: `Open repost and quote-post choices.${count}`,
        category: 'Engagement',
        confidence: 'inferred',
        basis: 'Second control in the repeated post engagement row.',
      });
    }
    if (action.x < 780) {
      return description({
        title: `Like ${subject}`,
        outcome: `Toggle your like on the post.${count}`,
        category: 'Engagement',
        confidence: 'inferred',
        basis: 'Third control in the repeated post engagement row.',
      });
    }
    if (action.x < 950) {
      return description({
        title: `Bookmark ${subject}`,
        outcome: 'Save or unsave the post in Bookmarks.',
        category: 'Engagement',
        confidence: 'inferred',
        basis: 'Icon-only control immediately after the analytics link.',
      });
    }
    return description({
      title: `Share ${subject}`,
      outcome: 'Open sharing and copy-link options.',
      category: 'Engagement',
      confidence: 'inferred',
      basis: 'Final icon-only control in the repeated post engagement row.',
    });
  };

  const describePostHeaderControl = (action, post) => {
    if (
      !post
      || action.type !== 'button'
      || action.innerText
      || action.x < 900
      || action.y - post.article.y > 48
    ) {
      return null;
    }
    const subject = `${post.author}’s post`;
    if (action.x < 950) {
      return description({
        title: `Use Grok with ${subject}`,
        outcome: 'Open X’s AI-assisted actions for this post.',
        category: 'Timeline',
        confidence: 'inferred',
        basis: 'First icon-only control at the upper-right of every post.',
      });
    }
    return description({
      title: `Open more options for ${subject}`,
      outcome: 'Open the post overflow menu.',
      category: 'Timeline',
      confidence: 'inferred',
      basis: 'Final icon-only control at the upper-right of every post.',
    });
  };

  const describeLink = (action, post) => {
    const label = truncate(action.innerText || 'this destination');
    if (!action.href) {
      if (post && action.width <= 20 && action.height <= 20) {
        return description({
          title: `Open verification details for ${post.author}`,
          outcome: 'Show information about the account’s verification badge.',
          category: 'Account',
          confidence: 'inferred',
          basis: 'Small link beside the author name; no href or icon was captured.',
        });
      }
      if (post && action.width > 120) {
        return description({
          title: `Open embedded content in ${post.author}’s post`,
          outcome: `Open the quoted post or linked card: “${label}”.`,
          category: 'Timeline',
          confidence: action.innerText ? 'inferred' : 'unclear',
          basis: 'Link-like region inside a post without a captured href.',
        });
      }
      if (action.innerText.startsWith('Trending')) {
        return description({
          title: `Open trend: ${label}`,
          outcome: 'Open the topic’s trend results.',
          category: 'Discovery',
          confidence: 'confirmed',
          basis: 'The XML labels this region as a trend link.',
        });
      }
      if (action.innerText) {
        return description({
          title: `Open “${label}”`,
          outcome: 'Activate this labeled link-like region.',
          category: regionFor(action) === 'discovery' ? 'Discovery' : 'Navigation',
          confidence: 'confirmed',
          basis: 'Named inner text and link role in the XML; no href was exposed.',
        });
      }
      return description({
        title: `Use unidentified link ${action.id}`,
        outcome: 'Activate an icon-only link whose destination was not captured.',
        category: 'Unclear',
        confidence: 'unclear',
        basis: 'No inner text, icon, aria label, or href is available.',
      });
    }

    let url;
    try {
      url = new URL(action.href);
    } catch (error) {
      return description({
        title: `Open ${label}`,
        outcome: `Navigate to ${action.href}.`,
        category: 'Navigation',
        confidence: 'confirmed',
        basis: 'Captured href in the XML.',
      });
    }

    const knownNavigation = NAVIGATION_PATHS.get(url.pathname);
    if (knownNavigation) {
      const [title, outcome] = knownNavigation;
      return description({
        title,
        outcome,
        category: url.pathname === '/compose/post' ? 'Compose' : 'Navigation',
        confidence: 'confirmed',
        basis: 'Exact captured href in the XML.',
      });
    }

    const segments = url.pathname.split('/').filter(Boolean);
    const statusIndex = segments.indexOf('status');
    if (statusIndex > 0) {
      const handle = `@${segments[statusIndex - 1]}`;
      const photoIndex = segments.indexOf('photo');
      if (photoIndex > -1) {
        return description({
          title: `View photo ${segments[photoIndex + 1] || ''} from ${handle}`.trim(),
          outcome: 'Open the post’s media viewer.',
          category: 'Media',
          confidence: 'confirmed',
          basis: 'Captured /status/…/photo href.',
        });
      }
      if (segments.includes('analytics')) {
        return description({
          title: `View analytics for ${handle}’s post`,
          outcome: `Open view and engagement analytics.${
            action.innerText ? ` Visible views: ${action.innerText}.` : ''
          }`,
          category: 'Timeline',
          confidence: 'confirmed',
          basis: 'Captured /analytics href.',
        });
      }
      return description({
        title: `Open ${handle}’s post`,
        outcome: 'Open the post detail and conversation.',
        category: 'Timeline',
        confidence: 'confirmed',
        basis: 'Captured /status/ href.',
      });
    }

    if (segments[0] === 'hashtag') {
      return description({
        title: `Explore #${decodeURIComponent(segments[1] || '').replace(/^#/, '')}`,
        outcome: 'Open posts using this hashtag.',
        category: 'Discovery',
        confidence: 'confirmed',
        basis: 'Captured hashtag href.',
      });
    }

    if (url.hostname === 't.co') {
      return description({
        title: `Open linked website: ${label}`,
        outcome: 'Follow X’s shortened link to the external destination.',
        category: 'Navigation',
        confidence: 'confirmed',
        basis: 'Captured t.co href and link text.',
      });
    }

    if (url.hostname === 'x.com' && segments.length === 1) {
      const handle = `@${segments[0]}`;
      return description({
        title: `Open ${handle} profile`,
        outcome: `View ${action.innerText ? `${truncate(action.innerText, 48)}’s` : `${handle}’s`} profile.`,
        category: 'Account',
        confidence: 'confirmed',
        basis: 'Captured single-handle X profile href.',
      });
    }

    if (segments[0] === 'i' && segments[1] === 'connect_people') {
      return description({
        title: 'Show more suggested accounts',
        outcome: 'Open the full account recommendation view.',
        category: 'Discovery',
        confidence: 'confirmed',
        basis: 'Captured connect_people href.',
      });
    }

    const helpLike = ['help.x.com', 'support.x.com', 'business.x.com'].includes(url.hostname);
    return description({
      title: `Open ${label}`,
      outcome: `Navigate to ${url.hostname}${url.pathname}.`,
      category: helpLike ? 'Help & policy' : 'Navigation',
      confidence: 'confirmed',
      basis: 'Captured href and link text in the XML.',
    });
  };

  const describeButton = (action, post, actions) => {
    const engagement = describeEngagementControl(action, post);
    if (engagement) {
      return engagement;
    }
    const postHeader = describePostHeaderControl(action, post);
    if (postHeader) {
      return postHeader;
    }

    if (action.innerText === 'Post') {
      return description({
        title: 'Publish the composed post',
        outcome: 'Submit the current composer contents to X.',
        category: 'Compose',
        confidence: 'confirmed',
        basis: 'Button inner text is “Post”.',
      });
    }
    if (action.innerText === 'Show more' && post) {
      return description({
        title: `Expand ${post.author}’s post`,
        outcome: 'Reveal the post text that is currently truncated.',
        category: 'Timeline',
        confidence: 'confirmed',
        basis: 'Button inner text is “Show more” inside the post.',
      });
    }
    if (action.innerText === 'Follow') {
      const suggestion = actions.find((candidate) => (
        candidate.type === 'listitem'
        && action.y >= candidate.y
        && action.y <= candidate.y + candidate.height
      ));
      const name = suggestion
        ? suggestion.innerText.replace(/\s+@[A-Za-z0-9_]+\s+Follow$/, '')
        : 'this account';
      return description({
        title: `Follow ${name}`,
        outcome: 'Add this account’s posts to your following network.',
        category: 'Engagement',
        confidence: 'confirmed',
        basis: 'Button inner text plus its enclosing account suggestion.',
      });
    }
    if (action.innerText === 'More') {
      const accountMenu = action.x < 400;
      return description({
        title: accountMenu ? 'Open more navigation' : 'Open more footer links',
        outcome: accountMenu
          ? 'Reveal additional X destinations and settings.'
          : 'Reveal additional legal, business, and policy links.',
        category: accountMenu ? 'Navigation' : 'Help & policy',
        confidence: 'confirmed',
        basis: 'Button inner text and page region.',
      });
    }
    if (action.x > 1300 && action.x < 1400 && action.width < 30) {
      return description({
        title: 'Open trend options',
        outcome: 'Open the overflow menu for this trend.',
        category: 'Discovery',
        confidence: 'inferred',
        basis: 'Repeated icon-only button at the right edge of trend rows.',
      });
    }
    if (post && action.width >= 55 && action.height >= 55) {
      return description({
        title: `Control media in ${post.author}’s post`,
        outcome: 'Play, pause, or resume the embedded media.',
        category: 'Media',
        confidence: 'inferred',
        basis: 'Large centered icon-only button inside a media region.',
      });
    }
    if (action.innerText) {
      return description({
        title: `Activate “${truncate(action.innerText)}”`,
        outcome: 'Use this labeled button.',
        category: regionFor(action) === 'discovery' ? 'Discovery' : 'Timeline',
        confidence: 'confirmed',
        basis: 'Button inner text in the XML.',
      });
    }
    return description({
      title: `Use unidentified icon button ${action.id}`,
      outcome: 'Activate this visible button; its icon and aria label were not captured.',
      category: 'Unclear',
      confidence: 'unclear',
      basis: 'The XML contains geometry and button semantics only.',
    });
  };

  const describeAction = (action, context) => {
    const specific = describeSpecific(action);
    if (specific) {
      return specific;
    }
    const composer = describeComposerTool(action);
    if (composer) {
      return composer;
    }

    const post = postForAction(action, context.posts);
    if (action.type === 'tab') {
      return description({
        title: `Switch the Home feed to “${action.innerText}”`,
        outcome: 'Change which timeline X displays.',
        category: 'Timeline',
        confidence: 'confirmed',
        basis: 'Tab role and inner text in the XML.',
      });
    }
    if (action.type === 'textbox') {
      return description({
        title: 'Write a post',
        outcome: 'Focus the Home composer and enter post text.',
        category: 'Compose',
        confidence: 'confirmed',
        basis: 'Textbox role in the composer region.',
      });
    }
    if (action.type === 'combobox') {
      return description({
        title: 'Search X',
        outcome: 'Enter a query for accounts, posts, topics, or media.',
        category: 'Discovery',
        confidence: 'confirmed',
        basis: 'Combobox role in X’s search position.',
      });
    }
    if (action.type === 'article') {
      const articlePost = parsePost(action);
      return description({
        title: `Open ${articlePost.author}’s post`,
        outcome: 'Open the post detail and its conversation thread.',
        category: 'Timeline',
        confidence: 'inferred',
        basis: 'Clickable article-sized region in the Home timeline.',
      });
    }
    if (action.type === 'listitem') {
      const name = action.innerText.replace(/\s+@[A-Za-z0-9_]+\s+Follow$/, '');
      return description({
        title: `Open suggested account: ${name}`,
        outcome: 'Open this account recommendation or its profile.',
        category: 'Discovery',
        confidence: 'inferred',
        basis: 'Clickable list item in the Who to follow module.',
      });
    }
    if (action.type === 'link') {
      return describeLink(action, post);
    }
    if (action.type === 'button') {
      return describeButton(action, post, context.actions);
    }
    if (action.type === 'action' && post && action.width > 250 && action.height > 100) {
      return description({
        title: `Control media in ${post.author}’s post`,
        outcome: action.innerText
          ? `Use the media player. Current player text: ${truncate(action.innerText, 64)}.`
          : 'Use the embedded media player.',
        category: 'Media',
        confidence: 'inferred',
        basis: 'Large interactive region inside a post.',
      });
    }
    return description({
      title: `Use detected action ${action.id}`,
      outcome: action.innerText
        ? `Activate “${truncate(action.innerText)}”.`
        : 'Activate this region; the XML does not expose a more specific purpose.',
      category: 'Unclear',
      confidence: action.innerText ? 'inferred' : 'unclear',
      basis: 'Generic action semantics from the XML.',
    });
  };

  const createActionModel = (snapshot) => {
    const actions = snapshot.actions.map(normalizeRecord);
    const posts = actions.filter(({ type }) => type === 'article').map(parsePost);
    const context = { actions, posts };
    const describedActions = actions.map((action) => ({
      ...action,
      region: regionFor(action),
      regionLabel: REGION_LABELS[regionFor(action)],
      ...describeAction(action, context),
    }));

    return {
      meta: {
        ...snapshot.meta,
        width: Number.parseFloat(snapshot.meta.width),
        height: Number.parseFloat(snapshot.meta.height),
      },
      actions: describedActions,
      groups: snapshot.groups,
      images: snapshot.images,
      regionLabels: REGION_LABELS,
    };
  };

  globalThis.XActionModel = Object.freeze({ createActionModel });
})();
