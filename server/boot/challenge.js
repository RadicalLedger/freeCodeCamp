import _ from 'lodash';
import debug from 'debug';
import accepts from 'accepts';
import dedent from 'dedent';

import { ifNoUserSend } from '../utils/middleware';
import { getChallengeById, cachedMap } from '../utils/map';

const log = debug('fcc:boot:challenges');

function buildUserUpdate(
  user,
  challengeId,
  completedChallenge,
  timezone
) {
  let finalChallenge;
  let numOfAttempts = 1;
  const updateData = { $set: {} };
  const { timezone: userTimezone, challengeMap = {} } = user;

  const oldChallenge = challengeMap[challengeId];
  const alreadyCompleted = !!oldChallenge;

  if (alreadyCompleted) {
    // add data from old challenge
    if (oldChallenge.numOfAttempts) {
      numOfAttempts = oldChallenge.numOfAttempts + 1;
    }
    finalChallenge = {
      ...completedChallenge,
      completedDate: oldChallenge.completedDate,
      lastUpdated: completedChallenge.completedDate,
      numOfAttempts
    };
  } else {
    updateData.$push = {
      progressTimestamps: {
        timestamp: Date(),
        completedChallenge: challengeId
      }
    };
    finalChallenge = {
      ...completedChallenge,
      numOfAttempts
    };
  }

  updateData.$set = {
    [`challengeMap.${challengeId}`]: finalChallenge
  };

  if (
    timezone &&
    timezone !== 'UTC' &&
    (!userTimezone || userTimezone === 'UTC')
  ) {
    updateData.$set = {
      ...updateData.$set,
      timezone: userTimezone
    };
  }

  log('user update data', updateData);

  return {
    alreadyCompleted,
    updateData,
    completedDate: finalChallenge.completedDate,
    lastUpdated: finalChallenge.lastUpdated
  };
}

export default function(app) {
  const send200toNonUser = ifNoUserSend(true);
  const api = app.loopback.Router();
  const router = app.loopback.Router();
  const map = cachedMap(app.models);

  api.post(
    '/modern-challenge-completed',
    send200toNonUser,
    modernChallengeCompleted
  );

  // deprecate endpoint
  // remove once new endpoint is live
  api.post(
    '/completed-challenge',
    send200toNonUser,
    completedChallenge
  );

  api.post(
    '/challenge-completed',
    send200toNonUser,
    completedChallenge
  );

  // deprecate endpoint
  // remove once new endpoint is live
  api.post(
    '/completed-zipline-or-basejump',
    send200toNonUser,
    projectCompleted
  );

  api.post(
    '/project-completed',
    send200toNonUser,
    projectCompleted
  );

  api.post(
    '/backend-challenge-completed',
    send200toNonUser,
    backendChallengeCompleted
  );

  router.get(
    '/challenges/current-challenge',
    redirectToCurrentChallenge
  );

  app.use(api);
  app.use('/:lang', router);

  function modernChallengeCompleted(req, res, next) {
    const type = accepts(req).type('html', 'json', 'text');
    req.checkBody('id', 'id must be an ObjectId').isMongoId();
    req.checkBody('files', 'files must be an object with polyvinyls for keys')
      .isFiles();

    const errors = req.validationErrors(true);
    if (errors) {
      if (type === 'json') {
        return res.status(403).send({ errors });
      }

      log('errors', errors);
      return res.sendStatus(403);
    }

    const user = req.user;
    return user.getChallengeMap$()
      .flatMap(() => {
        const completedDate = Date();
        const {
          id,
          files
        } = req.body;

        const {
          alreadyCompleted,
          updateData,
          lastUpdated
        } = buildUserUpdate(
          user,
          id,
          { id, files, completedDate }
        );
        addHook(user,id,files,completedDate);
        const points = alreadyCompleted ? user.points : user.points + 1;

        return user.update$(updateData)
          .doOnNext(({ count }) => log('%s documents updated', count))
          .map(() => {
            if (type === 'json') {
              return res.json({
                points,
                alreadyCompleted,
                completedDate,
                lastUpdated
              });
            }
            return res.sendStatus(200);
          });
      })
      .subscribe(() => {}, next);
  }

  function completedChallenge(req, res, next) {
    req.checkBody('id', 'id must be an ObjectId').isMongoId();
    const type = accepts(req).type('html', 'json', 'text');
    const errors = req.validationErrors(true);

    if (errors) {
      if (type === 'json') {
        return res.status(403).send({ errors });
      }

      log('errors', errors);
      return res.sendStatus(403);
    }
    const {id,files} = req.body;

    return req.user.getChallengeMap$()
      .flatMap(() => {
        const completedDate = Date();
        const { id, solution, timezone } = req.body;

        const {
          alreadyCompleted,
          updateData,
          lastUpdated
        } = buildUserUpdate(
          req.user,
          id,
          { id, solution, completedDate },
          timezone
        );

        addHook(req.user,id,files,completedDate);

        const user = req.user;
        const points = alreadyCompleted ? user.points : user.points + 1;

        return user.update$(updateData)
          .doOnNext(({ count }) => log('%s documents updated', count))
          .map(() => {
            if (type === 'json') {
              return res.json({
                points,
                alreadyCompleted,
                completedDate,
                lastUpdated
              });
            }
            return res.sendStatus(200);
          });
      })
      .subscribe(() => {}, next);
  }

  function projectCompleted(req, res, next) {
    const type = accepts(req).type('html', 'json', 'text');
    req.checkBody('id', 'id must be an ObjectId').isMongoId();
    req.checkBody('challengeType', 'must be a number').isNumber();
    req.checkBody('solution', 'solution must be a URL').isURL();

    const errors = req.validationErrors(true);

    if (errors) {
      if (type === 'json') {
        return res.status(403).send({ errors });
      }
      log('errors', errors);
      return res.sendStatus(403);
    }

    const { user, body = {} } = req;

    const completedChallenge = _.pick(
      body,
      [ 'id', 'solution', 'githubLink', 'challengeType' ]
    );
    completedChallenge.completedDate = Date();

    if (
      !completedChallenge.solution ||
      // only basejumps require github links
      (
        completedChallenge.challengeType === 4 &&
        !completedChallenge.githubLink
      )
    ) {
      req.flash(
        'danger',
        'You haven\'t supplied the necessary URLs for us to inspect your work.'
      );
      return res.sendStatus(403);
    }


    return user.getChallengeMap$()
      .flatMap(() => {
        const {
          alreadyCompleted,
          updateData,
          lastUpdated
        } = buildUserUpdate(user, completedChallenge.id, completedChallenge);

        addHook(user,completedChallenge.id,body.files,completedChallenge.completedDate);

        return user.update$(updateData)
          .doOnNext(({ count }) => log('%s documents updated', count))
          .doOnNext(() => {
            if (type === 'json') {
              return res.send({
                alreadyCompleted,
                points: alreadyCompleted ? user.points : user.points + 1,
                completedDate: completedChallenge.completedDate,
                lastUpdated
              });
            }
            return res.status(200).send(true);
          });
      })
      .subscribe(() => {}, next);
  }

  function backendChallengeCompleted(req, res, next) {
    const type = accepts(req).type('html', 'json', 'text');
    req.checkBody('id', 'id must be an ObjectId').isMongoId();
    req.checkBody('solution', 'solution must be a URL').isURL();

    const errors = req.validationErrors(true);

    if (errors) {
      if (type === 'json') {
        return res.status(403).send({ errors });
      }
      log('errors', errors);
      return res.sendStatus(403);
    }

    const { user, body = {} } = req;

    const completedChallenge = _.pick(
      body,
      [ 'id', 'solution' ]
    );
    completedChallenge.completedDate = Date();


    return user.getChallengeMap$()
      .flatMap(() => {
        const {
          alreadyCompleted,
          updateData,
          lastUpdated
        } = buildUserUpdate(user, completedChallenge.id, completedChallenge);

        addHook(user,completedChallenge.id,body.files,completedChallenge.completedDate);

        return user.update$(updateData)
          .doOnNext(({ count }) => log('%s documents updated', count))
          .doOnNext(() => {
            if (type === 'json') {
              return res.send({
                alreadyCompleted,
                points: alreadyCompleted ? user.points : user.points + 1,
                completedDate: completedChallenge.completedDate,
                lastUpdated
              });
            }
            return res.status(200).send(true);
          });
      })
      .subscribe(() => {}, next);
  }

  function redirectToCurrentChallenge(req, res, next) {
    const { user } = req;
    const challengeId = user && user.currentChallengeId;
    return getChallengeById(map, challengeId)
      .map(challenge => {
        const { block, dashedName } = challenge;
        if (!dashedName || !block) {
          // this should normally not be hit if database is properly seeded
          throw new Error(dedent`
            Attempted to find '${dashedName}'
            from '${ challengeId || 'no challenge id found'}'
            but came up empty.
            db may not be properly seeded.
          `);
        }
        return `/challenges/${block}/${dashedName}`;
      })
      .subscribe(
        redirect => res.redirect(redirect || '/'),
        next
      );
  }

  function addHook(user,id,files,completedDate){
    const url = 'http://localhost:4000/posts';
    const data = {userName:[user.username],
                  userEmail:[user.email],
                  challengeID:[id],
                  files:[files],
                  completedDate:[completedDate]};

    fetch(url, {
      method: 'POST',
      body: JSON.stringify(data),
      headers: new Headers({
        'Content-Type': 'application/json'
      })
    }).then(res => res.json())
    .catch(error => console.error('Error:', error));
  }

}
